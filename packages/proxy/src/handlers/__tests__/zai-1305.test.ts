/**
 * Zai returns HTTP 200 with a text/event-stream body whose first chunk carries
 * error code 1305 ("service overloaded"). These cover the detector that spots
 * it; the retry/fallback wiring around it lives in proxy-operations.ts, which
 * is not importable from tests (it pulls in @better-ccflare/database).
 */
import { describe, expect, it } from "bun:test";
import { hasZai1305Error } from "../zai-1305";

describe("hasZai1305Error", () => {
	it("detects the overload error in a first SSE chunk", () => {
		const chunk =
			'data: {"error":{"code":1305,"message":"The service is overloaded, please try again later"}}\n\n';
		expect(hasZai1305Error(chunk)).toBe(true);
	});

	it("ignores a normal stream opener", () => {
		const chunk =
			'data: {"id":"chatcmpl-1305","choices":[{"delta":{"content":"hi"}}]}\n\n';
		expect(hasZai1305Error(chunk)).toBe(false);
	});

	it("ignores an overload error that is not 1305", () => {
		const chunk =
			'data: {"error":{"code":1302,"message":"The service is overloaded"}}\n\n';
		expect(hasZai1305Error(chunk)).toBe(false);
	});

	it("is false for an empty chunk", () => {
		expect(hasZai1305Error("")).toBe(false);
	});
});
