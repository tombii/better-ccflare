import { describe, expect, it } from "bun:test";
import {
	formatModelRouting,
	type ModelRouting,
	providerSupportsProviderRouting,
	splitModelRouting,
	splitRoutingAwareList,
	stripModelRouting,
} from "./index";

describe("splitModelRouting", () => {
	it("leaves a plain model unchanged", () => {
		expect(splitModelRouting("deepseek/deepseek-v4.1-flash-1017")).toEqual({
			model: "deepseek/deepseek-v4.1-flash-1017",
			routing: null,
		});
		expect(splitModelRouting("z-ai/glm-4.5-air:free")).toEqual({
			model: "z-ai/glm-4.5-air:free",
			routing: null,
		});
	});

	it("handles an empty string", () => {
		expect(splitModelRouting("")).toEqual({ model: "", routing: null });
	});

	it("parses a trailing routing object", () => {
		const result = splitModelRouting(
			'deepseek/deepseek-v4.1-flash-1017 {"only":["deepseek"]}',
		);
		expect(result.model).toBe("deepseek/deepseek-v4.1-flash-1017");
		expect(result.routing).toEqual({ only: ["deepseek"] });
	});

	it("parses the full example with several keys", () => {
		const result = splitModelRouting(
			'z-ai/glm-4.5-air:free {"ignore":["deepseek"], "sort":"price", "allow_fallbacks":false}',
		);
		expect(result.model).toBe("z-ai/glm-4.5-air:free");
		expect(result.routing).toEqual({
			ignore: ["deepseek"],
			sort: "price",
			allow_fallbacks: false,
		});
	});

	it("tolerates no space and extra whitespace before the object", () => {
		expect(splitModelRouting('m {"only":["a"]}')).toEqual({
			model: "m",
			routing: { only: ["a"] },
		});
		expect(splitModelRouting('m   \t{"only":["a"]}')).toEqual({
			model: "m",
			routing: { only: ["a"] },
		});
	});

	it("parses every documented key", () => {
		const routing = {
			only: ["a"],
			order: ["a", "b"],
			sort: "throughput",
			allow_fallbacks: true,
			require_parameters: true,
			data_collection: "deny",
			max_price: { prompt: 1, completion: "2" },
			quantizations: ["fp8"],
		};
		const result = splitModelRouting(`m ${JSON.stringify(routing)}`);
		expect(result).toEqual({ model: "m", routing });
	});

	it("returns routing null for an empty object", () => {
		expect(splitModelRouting("m {}")).toEqual({ model: "m", routing: null });
	});

	it("returns routing null when every key is dropped", () => {
		expect(splitModelRouting('m {"unknown":1,"only":"not-an-array"}')).toEqual({
			model: "m",
			routing: null,
		});
	});

	it("returns routing null when all lists are empty after sanitising", () => {
		expect(splitModelRouting('m {"only":["","  "]}')).toEqual({
			model: "m",
			routing: null,
		});
	});

	it("keeps the whole string verbatim when the trailing object is not valid JSON", () => {
		// Routing null AND the model unfiltered: the malformed suffix is left in
		// the model id so the upstream rejects it visibly instead of silently
		// dropping characters and running the wrong model.
		expect(splitModelRouting("foo {bad json")).toEqual({
			model: "foo {bad json",
			routing: null,
		});
		expect(splitModelRouting('foo {"only":["a"]')).toEqual({
			model: 'foo {"only":["a"]',
			routing: null,
		});
	});

	it("does not treat a non-object trailing brace as routing", () => {
		expect(splitModelRouting("foo [1]")).toEqual({
			model: "foo [1]",
			routing: null,
		});
		expect(splitModelRouting('foo "{"')).toEqual({
			model: 'foo "{"',
			routing: null,
		});
	});

	it("does not misparse model ids containing a brace", () => {
		const model = "some/{weird}/model";
		expect(splitModelRouting(model)).toEqual({ model, routing: null });
		// Brace in the id, valid routing after it.
		expect(splitModelRouting('some/{weird}/model {"only":["x"]}')).toEqual({
			model: "some/{weird}/model",
			routing: { only: ["x"] },
		});
	});

	it("does not treat a JSON-looking array as routing", () => {
		expect(splitModelRouting('m ["a"]')).toEqual({
			model: 'm ["a"]',
			routing: null,
		});
	});

	it("normalises provider slugs: lowercase, trimmed, empties dropped", () => {
		expect(splitModelRouting('m {"only":[" DeepSeek ", "", "X"]}')).toEqual({
			model: "m",
			routing: { only: ["deepseek", "x"] },
		});
	});

	it("keeps only and drops ignore when both are present", () => {
		// An allow-list and a deny-list together cannot be satisfied by a single
		// upstream, and `only` is the narrower, more explicit intent — keeping it
		// matches what the operator most likely meant by listing providers.
		expect(splitModelRouting('m {"only":["a"],"ignore":["b"]}')).toEqual({
			model: "m",
			routing: { only: ["a"] },
		});
	});

	it("drops ignore and keeps only even when ignore comes second", () => {
		expect(splitModelRouting('m {"ignore":["b"],"only":["a"]}')).toEqual({
			model: "m",
			routing: { only: ["a"] },
		});
	});

	it("drops values of the wrong type instead of throwing", () => {
		expect(
			splitModelRouting(
				'm {"only":[1,true,"a"],"sort":5,"allow_fallbacks":"yes","data_collection":"maybe","max_price":[],"quantizations":"fp8","order":{}}',
			),
		).toEqual({ model: "m", routing: { only: ["a"] } });
	});

	it("ignores unknown keys", () => {
		expect(splitModelRouting('m {"only":["a"],"bogus":{"x":1}}')).toEqual({
			model: "m",
			routing: { only: ["a"] },
		});
	});
});

describe("stripModelRouting", () => {
	it("returns only the model part", () => {
		expect(stripModelRouting('deepseek/x {"only":["deepseek"]}')).toBe(
			"deepseek/x",
		);
		expect(stripModelRouting("deepseek/x")).toBe("deepseek/x");
	});

	it("keeps a malformed suffix in place", () => {
		expect(stripModelRouting("foo {bad json")).toBe("foo {bad json");
	});
});

describe("formatModelRouting", () => {
	it("is the inverse of splitModelRouting", () => {
		const original =
			'z-ai/glm-4.5-air:free {"ignore":["deepseek"],"sort":"price"}';
		const { model, routing } = splitModelRouting(original);
		expect(formatModelRouting(model, routing)).toBe(original);
	});

	it("returns the model alone for null or empty routing", () => {
		expect(formatModelRouting("m", null)).toBe("m");
		expect(formatModelRouting("m", {})).toBe("m");
		expect(formatModelRouting("m", { only: [] })).toBe("m");
	});

	it("trims the model", () => {
		expect(formatModelRouting("  m  ", null)).toBe("m");
	});

	it("serialises a routing object", () => {
		expect(formatModelRouting("m", { only: ["a"] })).toBe('m {"only":["a"]}');
	});
});

describe("splitRoutingAwareList", () => {
	it("splits a plain comma list and trims", () => {
		expect(splitRoutingAwareList(" a, b ,c")).toEqual(["a", "b", "c"]);
	});

	it("drops empty entries", () => {
		expect(splitRoutingAwareList("a,,b, ")).toEqual(["a", "b"]);
		expect(splitRoutingAwareList("")).toEqual([]);
	});

	it("does not split on commas inside the routing JSON", () => {
		expect(
			splitRoutingAwareList(
				'a {"only":["x","y"],"sort":"price"}, b, c {"ignore":["z"]}',
			),
		).toEqual([
			'a {"only":["x","y"],"sort":"price"}',
			"b",
			'c {"ignore":["z"]}',
		]);
	});

	it("keeps a model id with a brace intact", () => {
		expect(splitRoutingAwareList("a/{b}, c")).toEqual(["a/{b}", "c"]);
	});
});

describe("providerSupportsProviderRouting", () => {
	it("is true only for openrouter and nanogpt", () => {
		expect(providerSupportsProviderRouting("openrouter")).toBe(true);
		expect(providerSupportsProviderRouting("nanogpt")).toBe(true);
	});

	it("is false for everything else", () => {
		for (const p of [
			"anthropic",
			"claude-console-api",
			"openai-compatible",
			"zai",
			undefined,
			null,
			"",
		]) {
			expect(providerSupportsProviderRouting(p)).toBe(false);
		}
	});
});

// Type-level sanity: ModelRouting is exported and accepts every documented key.
const _routingShape: ModelRouting = { only: ["a"], max_price: { prompt: 1 } };
void _routingShape;
