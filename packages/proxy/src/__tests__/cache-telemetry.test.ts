import { describe, expect, test } from "bun:test";
import {
	CACHE_LOOKBACK_WINDOW_BLOCKS,
	trailingTurnBlockCount,
} from "../cache-telemetry";

describe("trailingTurnBlockCount", () => {
	test("counts array content blocks of the final message", () => {
		const blocks = Array.from({ length: 23 }, (_, i) => ({
			type: "tool_result",
			tool_use_id: `t${i}`,
			content: "ok",
		}));
		expect(
			trailingTurnBlockCount({
				messages: [
					{ role: "user", content: "hi" },
					{ role: "user", content: blocks },
				],
			}),
		).toBe(23);
	});

	test("string content counts as one block", () => {
		expect(
			trailingTurnBlockCount({ messages: [{ role: "user", content: "hi" }] }),
		).toBe(1);
	});

	test("malformed shapes count as zero", () => {
		expect(trailingTurnBlockCount(null)).toBe(0);
		expect(trailingTurnBlockCount({})).toBe(0);
		expect(trailingTurnBlockCount({ messages: [] })).toBe(0);
		expect(trailingTurnBlockCount({ messages: [null] })).toBe(0);
		expect(trailingTurnBlockCount({ messages: [{ role: "user" }] })).toBe(0);
	});

	test("window constant matches the documented lookback", () => {
		expect(CACHE_LOOKBACK_WINDOW_BLOCKS).toBe(20);
	});
});
