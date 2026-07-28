/// <reference types="bun-types" />
declare const process: { env: Record<string, string | undefined> };
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	CircuitBreaker,
	createStreamAdmission,
} from "@better-ccflare/proxy";

// Stub @better-ccflare/providers so the router's transitive imports of the
// vertex-ai provider (which requires google-auth-library) do not fail when
// the sandbox can't install it. The router only calls `dbOps` against our
// fake DatabaseOperations, so the provider surface is never exercised in
// this test. mock.module must be at the top level before resolving imports.
mock.module("@better-ccflare/providers", () => ({
	usageCache: {
		get: () => undefined,
	},
	getRepresentativeUtilizationForProvider: () => null,
	ProxyProvider: class {},
}));
mock.module("@better-ccflare/database", () => ({
	DatabaseOperations: class {},
}));

import type { APIContext } from "@better-ccflare/types";
import { APIRouter } from "../router";

/**
 * Build a minimal APIContext for the router. Only the fields the
 * capacity-state code path actually touches are populated; everything else
 * is stubbed because the test never exercises those branches. The context
 * shape is enforced by `APIContext` from @better-ccflare/types, so adding
 * a new required field there will fail this test's `as unknown as` cast
 * immediately — the right place to learn about new requirements.
 *
 * We mock `countActiveApiKeys()` to return > 0 so the auth service actually
 * requires an API key — otherwise the static-exemption guard in test 4
 * could be bypassed by the "no API keys configured" fallback, and the test
 * would pass for the wrong reason.
 */
function buildContext(circuitBreaker: CircuitBreaker): APIContext {
	const admission = createStreamAdmission();
	const noop = () => undefined;
	const dbOps = new Proxy(
		{
			countActiveApiKeys: async () => 1,
			getActiveApiKeys: async () => [
				{
					id: "test-key",
					name: "test",
					prefixLast8: "",
					hashedKey: "x",
					role: "admin" as const,
				},
			],
		},
		{
			get: (target, prop) => {
				if (prop in target) {
					return (target as Record<string | symbol, unknown>)[prop];
				}
				return noop;
			},
		},
	) as unknown as APIContext["dbOps"];
	const alertService = {
		listAlerts: async () => [],
		getUnacknowledgedCount: async () => 0,
		acknowledgeAlert: async () => true,
		acknowledgeAll: async () => {},
	};
	return {
		db: {} as unknown as APIContext["db"],
		config: {
			getStrategy: () => "session",
			getHealthDetailEnabled: () => false,
		} as unknown as APIContext["config"],
		dbOps,
		alertService,
		circuitBreaker,
		streamAdmission: admission,
	};
}

async function getCapacityState(
	context: APIContext,
	path: string = "/api/capacity-state",
	headers: Record<string, string> = {},
): Promise<Response> {
	const router = new APIRouter(context);
	const url = new URL(`http://localhost${path}`);
	const req = new Request(url.toString(), { method: "GET", headers });
	const response = await router.handleRequest(url, req);
	if (!response) {
		throw new Error(`No route registered for ${path}`);
	}
	return response;
}

describe("capacity-state handler", () => {
	let originalCircuitBreakerEnv: string | undefined;
	let originalStreamAdmissionEnv: string | undefined;

	beforeEach(() => {
		originalCircuitBreakerEnv = process.env.CCFLARE_CIRCUIT_BREAKER;
		originalStreamAdmissionEnv = process.env.CCFLARE_STREAM_ADMISSION;
	});

	afterEach(() => {
		if (originalCircuitBreakerEnv === undefined) {
			delete process.env.CCFLARE_CIRCUIT_BREAKER;
		} else {
			process.env.CCFLARE_CIRCUIT_BREAKER = originalCircuitBreakerEnv;
		}
		if (originalStreamAdmissionEnv === undefined) {
			delete process.env.CCFLARE_STREAM_ADMISSION;
		} else {
			process.env.CCFLARE_STREAM_ADMISSION = originalStreamAdmissionEnv;
		}
	});

	it("returns the documented shape with both modules idle", async () => {
		process.env.CCFLARE_CIRCUIT_BREAKER = "1";
		process.env.CCFLARE_STREAM_ADMISSION = "1";
		const breaker = new CircuitBreaker();
		const response = await getCapacityState(buildContext(breaker));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			enabled: { circuitBreaker: boolean; streamAdmission: boolean };
			circuitBreaker: { keys: unknown[] };
			streamAdmission: { passesThrough: boolean; accounts: Record<string, unknown> };
			generatedAt: number;
		};
		expect(body.enabled).toEqual({
			circuitBreaker: true,
			streamAdmission: true,
		});
		expect(body.circuitBreaker.keys).toEqual([]);
		expect(body.streamAdmission.passesThrough).toBe(false);
		expect(body.streamAdmission.accounts).toEqual({});
		expect(typeof body.generatedAt).toBe("number");
	});

	it("reports an open circuit and reflects enabled.circuitBreaker === true", async () => {
		process.env.CCFLARE_CIRCUIT_BREAKER = "1";
		const breaker = new CircuitBreaker();
		const key = { provider: "anthropic", accountId: "acc-1" };
		// Drive the breaker to OPEN: 5 failures of a kind that counts as a
		// circuit failure (the default branch in shouldCountAsCircuitFailure).
		for (let i = 0; i < 5; i++) {
			breaker.recordFailure(key, "upstream_529_overloaded_no_reset");
		}
		const response = await getCapacityState(buildContext(breaker));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			enabled: { circuitBreaker: boolean };
			circuitBreaker: {
				keys: Array<{
					state: string;
					provider: string;
					accountId: string;
					failureCount: number;
				}>;
			};
		};
		expect(body.enabled.circuitBreaker).toBe(true);
		expect(body.circuitBreaker.keys).toHaveLength(1);
		const entry = body.circuitBreaker.keys[0];
		expect(entry.state).toBe("open");
		expect(entry.provider).toBe("anthropic");
		expect(entry.accountId).toBe("acc-1");
		expect(entry.failureCount).toBe(5);
	});

	it("reflects CCFLARE_CIRCUIT_BREAKER=0 as enabled.circuitBreaker === false", async () => {
		process.env.CCFLARE_CIRCUIT_BREAKER = "0";
		const breaker = new CircuitBreaker();
		const response = await getCapacityState(buildContext(breaker));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			enabled: { circuitBreaker: boolean; streamAdmission: boolean };
		};
		expect(body.enabled.circuitBreaker).toBe(false);
	});

	it("is reachable without an API key — the AO fleet reaper's access pattern", async () => {
		process.env.CCFLARE_CIRCUIT_BREAKER = "1";
		const breaker = new CircuitBreaker();
		// No x-api-key header — the reaper runs on a different host and
		// does not carry the proxy's API key.
		const response = await getCapacityState(buildContext(breaker));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { generatedAt: number };
		expect(typeof body.generatedAt).toBe("number");
	});
});
