import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearRoutingObservations,
	getRoutingObservations,
	recordRoutingObservation,
} from "../routing-observations";

// beforeEach (not just afterEach): this is a process-wide singleton, and the
// full suite shares one process across test files -- another file that
// exercises the real proxy.ts request path can populate it before this file
// runs, so every test here must start from a guaranteed-clean slate rather
// than relying on execution order.
beforeEach(() => {
	clearRoutingObservations();
});
afterEach(() => {
	clearRoutingObservations();
});

describe("recordRoutingObservation / getRoutingObservations", () => {
	it("returns an empty object when nothing has been recorded", () => {
		expect(getRoutingObservations()).toEqual({});
	});

	it("records the order, model, and observedAtMs for a family", () => {
		const now = 1_700_000_000_000;
		recordRoutingObservation(
			"fable",
			[
				{ id: "acc-1", name: "Alice" },
				{ id: "acc-2", name: "Bob" },
			],
			"claude-fable-5",
			now,
		);

		const observations = getRoutingObservations();
		expect(observations).toEqual({
			fable: {
				family: "fable",
				order: [
					{ id: "acc-1", name: "Alice" },
					{ id: "acc-2", name: "Bob" },
				],
				model: "claude-fable-5",
				observedAtMs: now,
			},
		});
	});

	it("overwrites the previous entry for the same family (last-write-wins, no history)", () => {
		recordRoutingObservation(
			"opus",
			[{ id: "acc-1", name: "Alice" }],
			"claude-opus-4-6",
			1_000,
		);
		recordRoutingObservation(
			"opus",
			[
				{ id: "acc-2", name: "Bob" },
				{ id: "acc-1", name: "Alice" },
			],
			"claude-opus-4-6",
			2_000,
		);

		const observations = getRoutingObservations();
		expect(Object.keys(observations)).toEqual(["opus"]);
		expect(observations.opus).toEqual({
			family: "opus",
			order: [
				{ id: "acc-2", name: "Bob" },
				{ id: "acc-1", name: "Alice" },
			],
			model: "claude-opus-4-6",
			observedAtMs: 2_000,
		});
	});

	it("keeps entries for distinct families independent of one another", () => {
		recordRoutingObservation(
			"opus",
			[{ id: "acc-1", name: "Alice" }],
			"claude-opus-4-6",
			1_000,
		);
		recordRoutingObservation(
			"sonnet",
			[{ id: "acc-2", name: "Bob" }],
			"claude-sonnet-5-0",
			2_000,
		);

		const observations = getRoutingObservations();
		expect(Object.keys(observations).sort()).toEqual(["opus", "sonnet"]);
		expect(observations.opus?.model).toBe("claude-opus-4-6");
		expect(observations.sonnet?.model).toBe("claude-sonnet-5-0");
	});

	it("returns a copy: mutating the returned record does not affect internal state", () => {
		recordRoutingObservation(
			"haiku",
			[{ id: "acc-1", name: "Alice" }],
			"claude-haiku-5-0",
			1_000,
		);

		const first = getRoutingObservations();
		// Mutate the returned object and its nested order array.
		delete first.haiku;
		const second = getRoutingObservations();
		expect(second.haiku).toBeDefined();

		const secondCall = getRoutingObservations();
		secondCall.haiku?.order.push({ id: "acc-x", name: "Ghost" });
		const thirdCall = getRoutingObservations();
		expect(thirdCall.haiku?.order).toEqual([{ id: "acc-1", name: "Alice" }]);
	});

	it("defaults now to Date.now() when omitted", () => {
		const before = Date.now();
		recordRoutingObservation(
			"sonnet",
			[{ id: "acc-1", name: "Alice" }],
			"claude-sonnet-5-0",
		);
		const after = Date.now();

		const observations = getRoutingObservations();
		expect(observations.sonnet?.observedAtMs).toBeGreaterThanOrEqual(before);
		expect(observations.sonnet?.observedAtMs).toBeLessThanOrEqual(after);
	});
});

describe("clearRoutingObservations", () => {
	it("removes all recorded observations", () => {
		recordRoutingObservation(
			"opus",
			[{ id: "acc-1", name: "Alice" }],
			"claude-opus-4-6",
			1_000,
		);
		expect(Object.keys(getRoutingObservations())).toHaveLength(1);

		clearRoutingObservations();

		expect(getRoutingObservations()).toEqual({});
	});
});
