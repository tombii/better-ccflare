import { describe, expect, it } from "bun:test";
import {
	parseExpanded,
	readExpanded,
	toggleIn,
	writeExpanded,
} from "../usePersistedExpansion";

// No @testing-library/renderHook exists in this package (grepped before
// writing this file) and `window` is undefined in the bun test environment
// here (no DOM/jsdom preload configured for dashboard-web) -- so the hook
// itself is not rendered. Instead all state logic that usePersistedExpansion
// relies on is pulled into these pure, directly-testable functions:
// parseExpanded/toggleIn (as named in the task) plus readExpanded/writeExpanded
// (storage-object-injected, so the "no storage" / "storage throws" robustness
// requirements are testable without a DOM environment).

describe("parseExpanded", () => {
	it("returns [] for null", () => {
		expect(parseExpanded(null)).toEqual([]);
	});

	it("returns the array for valid JSON array of strings", () => {
		expect(parseExpanded('["a","b","c"]')).toEqual(["a", "b", "c"]);
	});

	it("returns [] for broken JSON instead of throwing", () => {
		expect(() => parseExpanded("{not json")).not.toThrow();
		expect(parseExpanded("{not json")).toEqual([]);
	});

	it("returns [] for non-array JSON (e.g. an object)", () => {
		expect(parseExpanded('{"a":1}')).toEqual([]);
	});

	it("filters out non-string elements from an otherwise-valid array", () => {
		expect(parseExpanded('["a",1,null,"b"]')).toEqual(["a", "b"]);
	});

	it("returns [] for an empty string", () => {
		expect(parseExpanded("")).toEqual([]);
	});
});

describe("toggleIn", () => {
	it("appends the id when absent", () => {
		expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
	});

	it("removes the id when present", () => {
		expect(toggleIn(["a", "b", "c"], "b")).toEqual(["a", "c"]);
	});

	it("does not mutate the input list", () => {
		const input = ["a"];
		toggleIn(input, "b");
		expect(input).toEqual(["a"]);
	});

	it("toggling twice returns to the original set (order preserved for survivors)", () => {
		const once = toggleIn(["a", "b"], "c");
		const twice = toggleIn(once, "c");
		expect(twice).toEqual(["a", "b"]);
	});
});

describe("readExpanded (storage-injected)", () => {
	it("returns [] when storage is unavailable (undefined)", () => {
		expect(readExpanded("k", undefined)).toEqual([]);
	});

	it("returns [] and does not throw when storage.getItem throws (private mode)", () => {
		const storage = {
			getItem: () => {
				throw new Error("SecurityError: access denied");
			},
			setItem: () => {},
		};
		expect(() => readExpanded("k", storage)).not.toThrow();
		expect(readExpanded("k", storage)).toEqual([]);
	});

	it("returns [] for corrupted JSON content read from storage", () => {
		const storage = {
			getItem: () => "{not json",
			setItem: () => {},
		};
		expect(readExpanded("k", storage)).toEqual([]);
	});

	it("returns [] for non-array JSON content read from storage", () => {
		const storage = {
			getItem: () => '{"a":1}',
			setItem: () => {},
		};
		expect(readExpanded("k", storage)).toEqual([]);
	});

	it("returns the persisted ids for valid stored JSON", () => {
		const storage = {
			getItem: () => '["x","y"]',
			setItem: () => {},
		};
		expect(readExpanded("k", storage)).toEqual(["x", "y"]);
	});
});

describe("writeExpanded (storage-injected)", () => {
	it("is a no-op when storage is unavailable (undefined)", () => {
		expect(() => writeExpanded("k", ["a"], undefined)).not.toThrow();
	});

	it("does not throw when storage.setItem throws (private mode / quota)", () => {
		const storage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		};
		expect(() => writeExpanded("k", ["a"], storage)).not.toThrow();
	});

	it("writes the ids as a JSON array string under the given key", () => {
		const calls: Array<[string, string]> = [];
		const storage = {
			getItem: () => null,
			setItem: (key: string, value: string) => {
				calls.push([key, value]);
			},
		};
		writeExpanded("ccflare.poolCapacity.expanded", ["a", "b"], storage);
		expect(calls).toEqual([
			["ccflare.poolCapacity.expanded", JSON.stringify(["a", "b"])],
		]);
	});
});

describe("write -> read round trip (simulates surviving a remount)", () => {
	it("a fresh read after a write returns the previously persisted ids", () => {
		let backing: string | null = null;
		const storage = {
			getItem: () => backing,
			setItem: (_key: string, value: string) => {
				backing = value;
			},
		};

		writeExpanded("k", ["five_hour", "scoped:Fable"], storage);

		// Simulates a remount: a brand new call to readExpanded against the
		// same underlying storage, independent of any in-memory state.
		expect(readExpanded("k", storage)).toEqual(["five_hour", "scoped:Fable"]);
	});
});
