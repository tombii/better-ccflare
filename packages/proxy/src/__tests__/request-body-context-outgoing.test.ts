import { describe, expect, it, spyOn } from "bun:test";
import { RequestBodyContext, readOutgoingBody } from "../request-body-context";

const encoder = new TextEncoder();

function bufferOf(body: unknown): ArrayBuffer {
	const bytes = encoder.encode(JSON.stringify(body));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}

function requestFor(buffer: ArrayBuffer): Request {
	return new Request("https://upstream.example/v1/messages", {
		method: "POST",
		body: new Uint8Array(buffer),
	});
}

describe("readOutgoingBody", () => {
	it("reuses the context model and does not parse when the request is untouched", async () => {
		const buffer = bufferOf({ model: "claude-sonnet", cache_control: {} });
		const context = new RequestBodyContext(buffer);
		context.getModel();
		const source = requestFor(buffer);
		const parse = spyOn(JSON, "parse");
		try {
			const outgoing = await readOutgoingBody(source, source, context, buffer);
			expect(outgoing.model).toBe("claude-sonnet");
			expect(outgoing.text).toBe(
				JSON.stringify({ model: "claude-sonnet", cache_control: {} }),
			);
			expect(parse).not.toHaveBeenCalled();
			expect(outgoing.getJson()).toEqual({
				model: "claude-sonnet",
				cache_control: {},
			});
			expect(parse).toHaveBeenCalledTimes(1);
		} finally {
			parse.mockRestore();
		}
	});

	it("parses the transformed body when the provider rewrote the request", async () => {
		const buffer = bufferOf({ model: "claude-sonnet" });
		const context = new RequestBodyContext(buffer);
		const source = requestFor(buffer);
		const transformed = requestFor(bufferOf({ model: "glm-5", extra: 1 }));
		const outgoing = await readOutgoingBody(
			transformed,
			source,
			context,
			buffer,
		);
		expect(outgoing.model).toBe("glm-5");
		expect(outgoing.getJson()).toEqual({ model: "glm-5", extra: 1 });
	});

	it("matches the previous behaviour for unparseable and model-less bodies", async () => {
		const bad = encoder.encode("not json").buffer as ArrayBuffer;
		const badSource = requestFor(bad);
		const badOut = await readOutgoingBody(
			badSource,
			badSource,
			new RequestBodyContext(bad),
			bad,
		);
		expect(badOut.model).toBe("");
		expect(badOut.text).toBe("not json");
		expect(badOut.getJson()).toBeNull();

		const noModel = bufferOf({ messages: [] });
		const noModelSource = requestFor(noModel);
		const noModelOut = await readOutgoingBody(
			noModelSource,
			noModelSource,
			new RequestBodyContext(noModel),
			noModel,
		);
		expect(noModelOut.model).toBe("");
		expect(noModelOut.getJson()).toEqual({ messages: [] });
	});

	it("uses the patched override model", async () => {
		const buffer = bufferOf({ model: "a" });
		const context = new RequestBodyContext(buffer).withPatchedModel("b");
		if (!context) throw new Error("patch failed");
		const patched = context.getBuffer();
		if (!patched) throw new Error("no buffer");
		const source = requestFor(patched);
		const outgoing = await readOutgoingBody(source, source, context, patched);
		expect(outgoing.model).toBe("b");
		expect(outgoing.text).toBe(JSON.stringify({ model: "b" }));
	});
});
