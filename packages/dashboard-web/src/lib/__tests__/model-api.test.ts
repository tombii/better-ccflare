import { describe, expect, it } from "bun:test";
import {
	firstModelInList,
	formatModelList,
	parseModelList,
} from "../model-api";

describe("parseModelList", () => {
	it("splits a plain comma-separated list", () => {
		expect(parseModelList("model-a, model-b ,model-c")).toEqual([
			"model-a",
			"model-b",
			"model-c",
		]);
	});

	it("keeps a routing suffix (with its own commas) on one element", () => {
		const value =
			'deepseek/deepseek-v4.1-flash-1017 {"only":["deepseek","novita"]}, qwen/qwen3-coder';
		expect(parseModelList(value)).toEqual([
			'deepseek/deepseek-v4.1-flash-1017 {"only":["deepseek","novita"]}',
			"qwen/qwen3-coder",
		]);
	});

	it("ignores empty elements", () => {
		expect(parseModelList(" , model-a, ,")).toEqual(["model-a"]);
	});
});

describe("formatModelList", () => {
	it("round-trips a routing-aware list", () => {
		const value =
			'deepseek/deepseek-v4.1-flash-1017 {"only":["deepseek"]}, qwen/qwen3-coder';
		expect(formatModelList(parseModelList(value))).toBe(value);
	});
});

describe("firstModelInList", () => {
	it("returns the first model with any routing suffix stripped", () => {
		expect(
			firstModelInList('a/b {"only":["deepseek"]}, c/d {"sort":"price"}'),
		).toBe("a/b");
		expect(firstModelInList("")).toBe("");
	});
});
