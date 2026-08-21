/**
 * A verified internal probe runs the whole request with `force_account_model`
 * treated as off.
 *
 * The setting suppresses every model rename, which is right for a client
 * request and wrong for a probe. The auto-refresh and cache-keepalive
 * schedulers send a compiled-in list of Claude ids — `HAIKU_4_5`, then
 * `SONNET_4_5`, then `SONNET_4` — to whatever account they are aimed at,
 * because the point is to touch the endpoint and read the answer, not to
 * deliver anyone's choice of model. Mapping is what makes that land on a
 * non-Claude account. Leaving the setting on for a probe therefore honours
 * nothing: `claude-haiku-4-5` goes to Codex untranslated, comes back as a
 * rejection that is neither 404 nor 529, counts as a refresh failure, and five
 * of those pause a healthy account with `pause_reason = 'failure_threshold'`.
 *
 * The exemption is keyed on the process-local probe secret, so a client that
 * copies the marker header out of a log gets nothing.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	isForceAccountModelEnabled,
	setForceAccountModel,
} from "@better-ccflare/core";
import type { ProxyContext } from "../handlers";
import { INTERNAL_PROBE_SECRET_HEADER } from "../handlers/proxy-types";
import { handleProxy } from "../proxy";

const SECRET = "probe-secret";

/**
 * `canHandle` is the first thing the request body of the handler calls, so what
 * it observes is what every later layer — selection, provider transform,
 * mapping — observes too.
 */
function makeContext(observed: boolean[]): ProxyContext {
	return {
		strategy: { select: () => [] } as never,
		dbOps: {
			getAllAccounts: mock(async () => []),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getForceAccountModel: () => true,
		} as never,
		provider: {
			name: "codex",
			canHandle: () => {
				observed.push(isForceAccountModelEnabled());
				return true;
			},
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		internalProbeSecret: SECRET,
	};
}

function makeRequest(headers: Record<string, string>): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-haiku-4-5",
			max_tokens: 10,
			messages: [{ role: "user", content: "probe" }],
		}),
	});
}

async function observeFlag(headers: Record<string, string>): Promise<boolean> {
	const observed: boolean[] = [];
	await handleProxy(
		makeRequest(headers),
		new URL("https://proxy.local/v1/messages"),
		makeContext(observed),
	);
	expect(observed).toHaveLength(1);
	return observed[0];
}

beforeEach(() => {
	setForceAccountModel(true);
});

afterEach(() => {
	setForceAccountModel(false);
});

describe("force_account_model — internal-probe exemption on the request path", () => {
	it("treats the setting as off for a secret-verified auto-refresh probe", async () => {
		expect(
			await observeFlag({
				"x-better-ccflare-auto-refresh": "true",
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
			}),
		).toBe(false);
	});

	it("does the same for the cache-keepalive probe", async () => {
		expect(
			await observeFlag({
				"x-better-ccflare-keepalive": "true",
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
			}),
		).toBe(false);
	});

	it("keeps the setting on for a marker sent with the wrong secret", async () => {
		expect(
			await observeFlag({
				"x-better-ccflare-auto-refresh": "true",
				[INTERNAL_PROBE_SECRET_HEADER]: "not-the-secret",
			}),
		).toBe(true);
	});

	it("keeps the setting on for a marker sent with no secret at all", async () => {
		expect(await observeFlag({ "x-better-ccflare-auto-refresh": "true" })).toBe(
			true,
		);
	});

	it("keeps the setting on for ordinary client traffic", async () => {
		expect(await observeFlag({})).toBe(true);
	});

	it("restores the flag once the request is done", async () => {
		await observeFlag({
			"x-better-ccflare-auto-refresh": "true",
			[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
		});

		expect(isForceAccountModelEnabled()).toBe(true);
	});
});
