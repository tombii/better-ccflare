/**
 * Tests for createRoutingObservationsHandler
 * (packages/http-api/src/handlers/routing-observations.ts).
 *
 * Verifies the /api/routing/observations response shape:
 * `{ observations: { [family]: RoutingObservation } }`.
 *
 * getRoutingObservations() is a process-singleton read out of @better-ccflare/proxy
 * (routing-observations.ts); its record/clear setters are intentionally NOT
 * re-exported from the package's top-level index (mirrors model-capacity.ts's
 * clearFamilyExhaustionCache, also internal-only), so this test controls the
 * singleton's return value via mock.module instead -- same pattern as
 * oauth.test.ts's clearAccountRefreshCache mock in this same package. mock.module
 * replaces the WHOLE module globally/across files in Bun, so the real module is
 * captured first and spread through, and restored in afterAll.
 */
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import type { RoutingObservation } from "@better-ccflare/proxy";

const actualProxy = await import("@better-ccflare/proxy");
let mockObservations: Record<string, RoutingObservation> = {};
const mockGetRoutingObservations = mock(() => mockObservations);

mock.module("@better-ccflare/proxy", () => ({
	...actualProxy,
	getRoutingObservations: mockGetRoutingObservations,
}));

afterAll(() => {
	mock.module("@better-ccflare/proxy", () => actualProxy);
});

afterEach(() => {
	mockObservations = {};
});

const { createRoutingObservationsHandler } = await import(
	"../routing-observations"
);

describe("createRoutingObservationsHandler", () => {
	it("returns HTTP 200 with an empty observations object when nothing was recorded", async () => {
		const handler = createRoutingObservationsHandler();
		const response = await handler();
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({ observations: {} });
	});

	it("returns application/json content-type", async () => {
		const handler = createRoutingObservationsHandler();
		const response = await handler();
		expect(response.headers.get("content-type")).toMatch(/application\/json/);
	});

	it("wraps getRoutingObservations() under the observations key, keyed by family", async () => {
		mockObservations = {
			fable: {
				family: "fable",
				order: [
					{ id: "acc-1", name: "Alice" },
					{ id: "acc-2", name: "Bob" },
				],
				model: "claude-fable-5",
				observedAtMs: 1_700_000_000_000,
			},
		};

		const handler = createRoutingObservationsHandler();
		const response = await handler();
		const body = (await response.json()) as {
			observations: Record<string, unknown>;
		};

		expect(Object.keys(body.observations)).toEqual(["fable"]);
		expect(body.observations.fable).toEqual({
			family: "fable",
			order: [
				{ id: "acc-1", name: "Alice" },
				{ id: "acc-2", name: "Bob" },
			],
			model: "claude-fable-5",
			observedAtMs: 1_700_000_000_000,
		});
	});

	it("reflects multiple families independently", async () => {
		mockObservations = {
			opus: {
				family: "opus",
				order: [{ id: "acc-1", name: "Alice" }],
				model: "claude-opus-4-6",
				observedAtMs: 1_000,
			},
			sonnet: {
				family: "sonnet",
				order: [{ id: "acc-2", name: "Bob" }],
				model: "claude-sonnet-5-0",
				observedAtMs: 2_000,
			},
		};

		const handler = createRoutingObservationsHandler();
		const response = await handler();
		const body = (await response.json()) as {
			observations: Record<string, unknown>;
		};

		expect(Object.keys(body.observations).sort()).toEqual(["opus", "sonnet"]);
	});

	it("calls getRoutingObservations() exactly once per request", async () => {
		mockGetRoutingObservations.mockClear();
		const handler = createRoutingObservationsHandler();
		await handler();
		expect(mockGetRoutingObservations).toHaveBeenCalledTimes(1);
	});
});
