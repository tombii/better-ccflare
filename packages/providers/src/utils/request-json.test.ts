import { describe, expect, it, spyOn } from "bun:test";
import {
	transformRequestBodyModel,
	transformRequestBodyModelForce,
} from "./model-mapping";
import { readRequestJson } from "./request-json";

const body = {
	model: "claude-sonnet-4-5",
	messages: [{ role: "user", content: "hello" }],
	max_tokens: 16,
};

function makeRequest(): Request {
	return new Request("http://test.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("readRequestJson", () => {
	it("returns the parsed body and leaves the original request unconsumed", async () => {
		const request = makeRequest();

		expect(await readRequestJson(request)).toEqual(body);
		expect(request.bodyUsed).toBe(false);
		expect(await request.json()).toEqual(body);
	});

	it("rejects a non-JSON body", async () => {
		const request = new Request("http://test.com/v1/messages", {
			method: "POST",
			body: "not json",
		});

		await expect(readRequestJson(request)).rejects.toThrow();
		expect(request.bodyUsed).toBe(false);
	});

	// Regression guard for #382. The leak is specific to `.json()` on a cloned
	// Request under Bun 1.3.x; the parsed output is identical either way, so the
	// transform tests cannot tell the two reads apart. This one can: it fails if
	// any request-body inspection path goes back to `clone().json()`.
	it("never reads a cloned Request through .json()", async () => {
		const jsonSpy = spyOn(Request.prototype, "json");
		const textSpy = spyOn(Request.prototype, "text");
		try {
			await readRequestJson(makeRequest());
			await transformRequestBodyModel(makeRequest(), undefined, (model) =>
				model === body.model ? "mapped-model" : model,
			);
			await transformRequestBodyModelForce(makeRequest(), "forced-model");

			expect(jsonSpy).not.toHaveBeenCalled();
			expect(textSpy).toHaveBeenCalledTimes(3);
		} finally {
			jsonSpy.mockRestore();
			textSpy.mockRestore();
		}
	});
});
