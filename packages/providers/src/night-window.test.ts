import { describe, expect, it } from "bun:test";
import { parseNightWindow } from "@better-ccflare/core";
// Side effect: registers the real sailresearch adapter, proving registration
// happens when the provider module loads.
import "./providers/sailresearch/tier";
import {
	applyNightWindowHeader,
	getTierAdapter,
	registerTierAdapter,
} from "./night-window";

const utc = (iso: string) => Date.parse(iso);

const w = parseNightWindow("22:00-08:00", "UTC");
if (!w) throw new Error("expected 22:00-08:00 UTC to parse");
const inWindow = utc("2026-11-09T23:00:00Z");
const outWindow = utc("2026-11-09T12:00:00Z");

const SAIL_HEADER = "x-sail-completion-window";

function makeHeaders(initial?: Record<string, string>): Headers {
	return new Headers(initial);
}

describe("registration", () => {
	it("registers the sailresearch adapter on import", () => {
		expect(getTierAdapter("sailresearch")).toEqual({
			provider: "sailresearch",
			header: SAIL_HEADER,
			tier: "balanced",
		});
	});

	it("returns undefined for an unregistered provider", () => {
		expect(getTierAdapter("some-unregistered-provider")).toBeUndefined();
	});
});

describe("applyNightWindowHeader (sailresearch)", () => {
	it("leaves headers alone for a provider with no adapter registered", () => {
		// Deletion is scoped to the adapter's own header, so a provider that
		// never registered an adapter is not touched at all.
		const headers = makeHeaders({ [SAIL_HEADER]: "asap" });
		applyNightWindowHeader(
			headers,
			"anthropic",
			{ night_window_enabled: true },
			w,
			inWindow,
		);
		expect(headers.get(SAIL_HEADER)).toBe("asap");
	});

	it("always deletes a client-supplied header when the account is disabled", () => {
		const headers = makeHeaders({ [SAIL_HEADER]: "balanced" });
		applyNightWindowHeader(
			headers,
			"sailresearch",
			{ night_window_enabled: false },
			w,
			inWindow,
		);
		expect(headers.has(SAIL_HEADER)).toBe(false);
	});

	it("always deletes a client-supplied header when the window is null", () => {
		const headers = makeHeaders({ [SAIL_HEADER]: "asap" });
		applyNightWindowHeader(
			headers,
			"sailresearch",
			{ night_window_enabled: true },
			null,
			inWindow,
		);
		expect(headers.has(SAIL_HEADER)).toBe(false);
	});

	it("sets balanced when provider, flag, window and time all line up", () => {
		const headers = makeHeaders({ [SAIL_HEADER]: "asap" });
		applyNightWindowHeader(
			headers,
			"sailresearch",
			{ night_window_enabled: true },
			w,
			inWindow,
		);
		expect(headers.get(SAIL_HEADER)).toBe("balanced");
	});

	it("accepts 1/0 (SQLite INTEGER) for the account flag", () => {
		const on = makeHeaders();
		applyNightWindowHeader(
			on,
			"sailresearch",
			{ night_window_enabled: 1 },
			w,
			inWindow,
		);
		expect(on.get(SAIL_HEADER)).toBe("balanced");

		const off = makeHeaders();
		applyNightWindowHeader(
			off,
			"sailresearch",
			{ night_window_enabled: 0 },
			w,
			inWindow,
		);
		expect(off.has(SAIL_HEADER)).toBe(false);
	});

	it("does not set the header outside the window", () => {
		const headers = makeHeaders();
		applyNightWindowHeader(
			headers,
			"sailresearch",
			{ night_window_enabled: true },
			w,
			outWindow,
		);
		expect(headers.has(SAIL_HEADER)).toBe(false);
	});

	it("does not set the header for a non-sail provider", () => {
		const headers = makeHeaders();
		applyNightWindowHeader(
			headers,
			"anthropic-compatible",
			{ night_window_enabled: true },
			w,
			inWindow,
		);
		expect(headers.has(SAIL_HEADER)).toBe(false);
	});

	it("does not set the header for another registered provider", () => {
		const headers = makeHeaders();
		applyNightWindowHeader(
			headers,
			"other",
			{ night_window_enabled: true },
			w,
			inWindow,
		);
		expect(headers.has(SAIL_HEADER)).toBe(false);
	});

	it("does not set the header when the account flag is missing", () => {
		const headers = makeHeaders();
		applyNightWindowHeader(headers, "sailresearch", {}, w, inWindow);
		expect(headers.has(SAIL_HEADER)).toBe(false);
	});

	it("never sets asap", () => {
		const headers = makeHeaders();
		applyNightWindowHeader(
			headers,
			"sailresearch",
			{ night_window_enabled: true },
			w,
			outWindow,
		);
		expect(headers.get(SAIL_HEADER)).not.toBe("asap");
	});
});

describe("applyNightWindowHeader (provider-agnostic)", () => {
	// A second provider with its own header and tier. Proves the shared layer
	// needs no per-provider edits: registering an adapter is enough.
	const OTHER_HEADER = "x-other-tier";
	registerTierAdapter({ provider: "other", header: OTHER_HEADER, tier: "eco" });

	it("gives a second provider its OWN header and tier", () => {
		const headers = makeHeaders();
		applyNightWindowHeader(
			headers,
			"other",
			{ night_window_enabled: true },
			w,
			inWindow,
		);
		expect(headers.get(OTHER_HEADER)).toBe("eco");
		expect(headers.has(SAIL_HEADER)).toBe(false);
	});

	it("does not touch the other provider's header for sailresearch", () => {
		const headers = makeHeaders({ [OTHER_HEADER]: "premium" });
		applyNightWindowHeader(
			headers,
			"sailresearch",
			{ night_window_enabled: true },
			w,
			inWindow,
		);
		expect(headers.get(SAIL_HEADER)).toBe("balanced");
		expect(headers.get(OTHER_HEADER)).toBe("premium");
	});

	it("does nothing for a provider with no adapter", () => {
		const headers = makeHeaders();
		applyNightWindowHeader(
			headers,
			"no-adapter-here",
			{ night_window_enabled: true },
			w,
			inWindow,
		);
		expect([...headers.keys()]).toEqual([]);
	});
});
