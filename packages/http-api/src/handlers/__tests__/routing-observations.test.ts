/**
 * Tests for createRoutingObservationsHandler
 * (packages/http-api/src/handlers/routing-observations.ts).
 *
 * Verifies the /api/routing/observations response shape:
 * `{ observations: { [family]: RoutingObservation } }`.
 *
 * The handler takes its reader as an injected dependency, so these tests pass
 * a fake directly instead of mocking the proxy module. That matters: Bun's
 * mock.module applies PROCESS-WIDE across file boundaries, so mocking
 * "@better-ccflare/proxy" here also replaced the module that the proxy
 * package's own routing-observations tests import, failing 6 of them whenever
 * both files ran in one `bun test` invocation (order-independent, reproduced
 * 2026-08-22). Injection keeps the two suites independent.
 */
import { describe, expect, it, mock } from "bun:test";
import type { RoutingObservation } from "@better-ccflare/proxy";
import { createRoutingObservationsHandler } from "../routing-observations";

describe("createRoutingObservationsHandler", () => {
	it("returns HTTP 200 with an empty observations object when nothing was recorded", async () => {
		const handler = createRoutingObservationsHandler(
			() => ({}) as Record<string, RoutingObservation>,
		);
		const response = await handler();
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({ observations: {} });
	});

	it("returns application/json content-type", async () => {
		const handler = createRoutingObservationsHandler(
			() => ({}) as Record<string, RoutingObservation>,
		);
		const response = await handler();
		expect(response.headers.get("content-type")).toMatch(/application\/json/);
	});

	it("wraps getRoutingObservations() under the observations key, keyed by family", async () => {
		const readObservations = mock(
			() =>
				({
					fable: {
						family: "fable",
						order: [
							{ id: "acc-1", name: "Alice" },
							{ id: "acc-2", name: "Bob" },
						],
						model: "claude-fable-5",
						observedAtMs: 1_700_000_000_000,
					},
				}) as unknown as () => Record<string, RoutingObservation>,
		);

		const handler = createRoutingObservationsHandler(readObservations);
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
		const readObservations = mock(
			() =>
				({
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
				}) as unknown as () => Record<string, RoutingObservation>,
		);

		const handler = createRoutingObservationsHandler(readObservations);
		const response = await handler();
		const body = (await response.json()) as {
			observations: Record<string, unknown>;
		};

		expect(Object.keys(body.observations).sort()).toEqual(["opus", "sonnet"]);
	});

	it("calls its reader exactly once per request", async () => {
		const readObservations = mock(
			() => ({}) as Record<string, RoutingObservation>,
		);
		const handler = createRoutingObservationsHandler(readObservations);
		await handler();
		expect(readObservations).toHaveBeenCalledTimes(1);
	});
});
