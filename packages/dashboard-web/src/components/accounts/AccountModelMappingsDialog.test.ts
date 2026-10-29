import { describe, expect, it } from "bun:test";
import { parseMappingValue } from "./AccountModelMappingsDialog";

describe("parseMappingValue", () => {
	it("returns a single model as a string", () => {
		expect(parseMappingValue(" model-a ")).toBe("model-a");
		expect(parseMappingValue("")).toBeNull();
	});

	it("splits a plain rotating list", () => {
		expect(parseMappingValue("model-a, model-b")).toEqual([
			"model-a",
			"model-b",
		]);
	});

	it("keeps a routing suffix with its own commas intact", () => {
		expect(
			parseMappingValue(
				'deepseek/deepseek-v4.1-flash-1017 {"only":["deepseek","novita"]}',
			),
		).toBe('deepseek/deepseek-v4.1-flash-1017 {"only":["deepseek","novita"]}');
		expect(
			parseMappingValue('a/b {"ignore":["deepseek"]}, c/d {"sort":"price"}'),
		).toEqual(['a/b {"ignore":["deepseek"]}', 'c/d {"sort":"price"}']);
	});
});
