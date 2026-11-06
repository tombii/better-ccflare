/**
 * Codex image passthrough.
 *
 * Anthropic `image` blocks used to be dropped on the Codex path: the message
 * loop had no `image` branch, and an image inside a tool_result was replaced by
 * a placeholder string, so a screenshot never reached the model. These tests
 * pin the Responses API wire shape (`input_image` with `image_url` as a bare
 * string) and the tool-result hoisting order.
 */
import { describe, expect, test } from "bun:test";
import { CodexProvider } from "./provider";

interface CodexBody {
	model: string;
	input: Array<Record<string, unknown>>;
	store: boolean;
	instructions?: string;
	tools?: Array<Record<string, unknown>>;
}

async function transform(messages: unknown[]): Promise<CodexBody> {
	const provider = new CodexProvider();
	const request = new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 100,
			messages,
		}),
	});
	const transformed = await provider.transformRequestBody(request);
	return (await transformed.json()) as CodexBody;
}

const base64Image = (data: string, mediaType?: string) => ({
	type: "image",
	source:
		mediaType === undefined
			? { type: "base64", data }
			: { type: "base64", media_type: mediaType, data },
});

const urlImage = (url: string) => ({
	type: "image",
	source: { type: "url", url },
});

function contentOf(item: Record<string, unknown> | undefined) {
	return item?.content as Array<Record<string, unknown>> | undefined;
}

/** Every `input_image` item anywhere in the request input. */
function imageItems(input: CodexBody["input"]) {
	return input.flatMap((item) =>
		(contentOf(item) ?? []).filter((part) => part.type === "input_image"),
	);
}

/**
 * Compact, ordered description of the emitted item sequence — one entry per
 * top-level input item — so tests can assert placement, not just presence.
 */
function itemShape(input: CodexBody["input"]): string[] {
	return input.map((item) => {
		if (item.type === "function_call") return `call:${String(item.call_id)}`;
		if (item.type === "function_call_output")
			return `output:${String(item.call_id)}`;
		const kinds = (contentOf(item) ?? []).map((part) => part.type).join("+");
		return `${String(item.role)}[${kinds}]`;
	});
}

const toolUse = (id: string, name = "Read") => ({
	type: "tool_use",
	id,
	name,
	input: { path: `${id}.png` },
});

const toolResultWith = (id: string, content: unknown[]) => ({
	type: "tool_result",
	tool_use_id: id,
	content,
});

describe("Codex transform — message-level image blocks", () => {
	test("keeps a text + image user turn in the client's original order", async () => {
		const body = await transform([
			{
				role: "user",
				content: [
					{ type: "text", text: "before" },
					base64Image("AAAA", "image/png"),
					{ type: "text", text: "after" },
				],
			},
		]);

		// One user item, with the image between the two text blocks.
		expect(itemShape(body.input)).toEqual([
			"user[input_text+input_image+input_text]",
		]);
		expect(contentOf(body.input[0])).toEqual([
			{ type: "input_text", text: "before" },
			{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
			{ type: "input_text", text: "after" },
		]);
	});

	test("emits an image-only user turn", async () => {
		const body = await transform([
			{ role: "user", content: [base64Image("BBBB", "image/jpeg")] },
		]);

		expect(itemShape(body.input)).toEqual(["user[input_image]"]);
		expect(body.input[0]).toEqual({
			role: "user",
			content: [
				{ type: "input_image", image_url: "data:image/jpeg;base64,BBBB" },
			],
		});
	});

	test("passes a URL source through unchanged as a bare string", async () => {
		const body = await transform([
			{ role: "user", content: [urlImage("https://example.com/cat.png")] },
		]);

		const image = imageItems(body.input)[0];
		// Responses takes `image_url` as a plain string, NOT the `{url}` object
		// used by chat completions. Sending the object shape is a 400.
		expect(typeof image?.image_url).toBe("string");
		expect(image).toEqual({
			type: "input_image",
			image_url: "https://example.com/cat.png",
		});
	});

	test("defaults media_type to image/png when the source omits it", async () => {
		const body = await transform([
			{ role: "user", content: [base64Image("CCCC")] },
		]);

		expect(imageItems(body.input)).toEqual([
			{ type: "input_image", image_url: "data:image/png;base64,CCCC" },
		]);
	});

	test("skips a malformed image block instead of emitting an item", async () => {
		const body = await transform([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", source: { type: "base64" } }, // no data, no url
					{ type: "image" }, // no source at all
					{ type: "image", source: null },
					{ type: "image", source: "https://example.com/x.png" },
				],
			},
		]);

		expect(imageItems(body.input)).toEqual([]);
		// The text still reaches the model.
		expect(itemShape(body.input)).toEqual(["user[input_text]"]);
	});

	test("does not emit input_image on an assistant turn", async () => {
		const body = await transform([
			{ role: "user", content: "describe it" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "here" },
					base64Image("DDDD", "image/png"),
				],
			},
		]);

		// Responses assistant content is `output_text`; there is no output-side
		// image item, so the image is dropped rather than emitted.
		expect(imageItems(body.input)).toEqual([]);
		expect(body.input[1]).toEqual({
			role: "assistant",
			content: [{ type: "output_text", text: "here" }],
		});
		expect(JSON.stringify(body.input)).not.toContain("DDDD");
	});
});

describe("Codex transform — images inside tool_result", () => {
	test("keeps the placeholder in the output and hoists the image to a user item", async () => {
		const body = await transform([
			{ role: "user", content: "read the screenshot" },
			{ role: "assistant", content: [toolUse("t1")] },
			{
				role: "user",
				content: [
					toolResultWith("t1", [
						{ type: "text", text: "Here is the image:" },
						base64Image("EEEE", "image/png"),
					]),
				],
			},
			{ role: "user", content: [{ type: "text", text: "later turn" }] },
		]);

		const output = body.input.find((i) => i.type === "function_call_output");
		expect(output?.output).toBe(
			"Here is the image:\n[image attached in the following message]",
		);
		expect(String(output?.output)).not.toContain("EEEE");

		// The hoisted image is a user item placed after the output it came from
		// and BEFORE the later turn.
		expect(itemShape(body.input)).toEqual([
			"user[input_text]",
			"call:t1",
			"output:t1",
			"user[input_image]",
			"user[input_text]",
		]);
		expect(body.input[3]).toEqual({
			role: "user",
			content: [
				{ type: "input_image", image_url: "data:image/png;base64,EEEE" },
			],
		});
	});

	test("hoists to a user item even when the tool_result sits on an assistant turn", async () => {
		const body = await transform([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [toolUse("t1")] },
			{
				role: "assistant",
				content: [toolResultWith("t1", [base64Image("FFFF")])],
			},
		]);

		expect(itemShape(body.input)).toEqual([
			"user[input_text]",
			"call:t1",
			"output:t1",
			"user[input_image]",
		]);
		expect(body.input[3]?.role).toBe("user");
		expect(imageItems(body.input)).toEqual([
			{ type: "input_image", image_url: "data:image/png;base64,FFFF" },
		]);
	});

	test("keeps each screenshot beside its own tool result across two rounds", async () => {
		const round = (id: string, data: string) => [
			{ role: "assistant", content: [toolUse(id)] },
			{ role: "user", content: [toolResultWith(id, [base64Image(data)])] },
		];

		const body = await transform([
			{ role: "user", content: "first" },
			...round("t1", "FIRST"),
			{ role: "assistant", content: "looked at first" },
			...round("t2", "SECOND"),
			{ role: "user", content: [{ type: "text", text: "compare" }] },
		]);

		// Each image immediately follows its OWN output; neither trails the
		// conversation, and the client's final text is still the last item.
		expect(itemShape(body.input)).toEqual([
			"user[input_text]",
			"call:t1",
			"output:t1",
			"user[input_image]",
			"assistant[output_text]",
			"call:t2",
			"output:t2",
			"user[input_image]",
			"user[input_text]",
		]);

		expect(imageItems(body.input)).toEqual([
			{ type: "input_image", image_url: "data:image/png;base64,FIRST" },
			{ type: "input_image", image_url: "data:image/png;base64,SECOND" },
		]);
	});

	test("adds no user item when a tool_result carries no image", async () => {
		const body = await transform([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [toolUse("t1", "Bash")] },
			{
				role: "user",
				content: [toolResultWith("t1", [{ type: "text", text: "ok" }])],
			},
			{ role: "user", content: [{ type: "text", text: "next" }] },
		]);

		expect(itemShape(body.input)).toEqual([
			"user[input_text]",
			"call:t1",
			"output:t1",
			"user[input_text]",
		]);
		expect(imageItems(body.input)).toEqual([]);
	});

	// A block with no usable source is dropped by the mapper, so nothing is
	// hoisted. The placeholder must not promise an image that never arrives —
	// with several tool results the model would credit a sibling's image to this
	// one.
	test("skips a malformed tool_result image and says the image is unavailable", async () => {
		const body = await transform([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [toolUse("t1")] },
			{
				role: "user",
				content: [toolResultWith("t1", [{ type: "image", source: {} }])],
			},
		]);

		const output = body.input.find((i) => i.type === "function_call_output");
		expect(output?.output).toBe(
			"[image unavailable: the tool result carried none]",
		);
		// Nothing to hoist, so no empty user item is invented.
		expect(imageItems(body.input)).toEqual([]);
		expect(itemShape(body.input)).toEqual([
			"user[input_text]",
			"call:t1",
			"output:t1",
		]);
	});
});
