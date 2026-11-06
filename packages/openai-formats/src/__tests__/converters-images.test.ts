import { describe, expect, it } from "bun:test";
import { convertAnthropicRequestToOpenAI } from "../converters";
import type { AnthropicRequest, OpenAIMessage } from "../types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function anthropicRequest(
	overrides: Partial<AnthropicRequest> = {},
): AnthropicRequest {
	return {
		model: "claude-sonnet-4-5",
		messages: [{ role: "user", content: "Hello" }],
		max_tokens: 100,
		...overrides,
	};
}

function imageParts(msg: OpenAIMessage | undefined) {
	if (!msg || !Array.isArray(msg.content)) throw new Error("expected array");
	return msg.content as Array<Record<string, unknown>>;
}

// ── User/assistant message images ────────────────────────────────────────────

describe("convertAnthropicRequestToOpenAI — images in messages", () => {
	it("converts a base64 image to an image_url data URL part", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "What is this?" },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "iVBORw0KGgo=",
								},
							},
						],
					},
				],
			}),
		);

		const user = result.messages.find((m) => m.role === "user");
		expect(user?.content).toEqual([
			{ type: "text", text: "What is this?" },
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
			},
		]);
	});

	it("passes a URL-sourced image through unchanged", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								source: { type: "url", url: "https://example.com/cat.png" },
							},
						],
					},
				],
			}),
		);

		const user = result.messages.find((m) => m.role === "user");
		expect(user?.content).toEqual([
			{ type: "image_url", image_url: { url: "https://example.com/cat.png" } },
		]);
	});

	it("defaults media_type to image/png when the source omits it", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", source: { type: "base64", data: "abc" } },
						],
					},
				],
			}),
		);

		const user = result.messages.find((m) => m.role === "user");
		expect(imageParts(user)[0]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/png;base64,abc" },
		});
	});

	it("keeps a message that contains only an image", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								source: { type: "url", url: "https://x/y.png" },
							},
						],
					},
				],
			}),
		);

		const users = result.messages.filter((m) => m.role === "user");
		expect(users).toHaveLength(1);
		expect(users[0]?.content).not.toBeNull();
	});

	it("still emits plain string content when there are no images", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Just text" }],
					},
				],
			}),
		);

		expect(result.messages.find((m) => m.role === "user")?.content).toBe(
			"Just text",
		);
	});
});

// ── Tool-result images ───────────────────────────────────────────────────────

describe("convertAnthropicRequestToOpenAI — images in tool results", () => {
	it("keeps the placeholder in the tool message and hoists the image to a user turn", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{ role: "user", content: "read the screenshot" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_1",
								name: "Read",
								input: { path: "a.png" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_1",
								content: [
									{ type: "text", text: "Here is the image:" },
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "abc123",
										},
									},
								],
							},
						],
					},
				],
			}),
		);

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg?.content).toContain("Here is the image:");
		expect(toolMsg?.content).toContain(
			"[image attached in the following message]",
		);

		const last = result.messages[result.messages.length - 1];
		expect(last?.role).toBe("user");
		expect(last?.content).toEqual([
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,abc123" },
			},
		]);
	});

	it("keeps each screenshot next to its own tool result across rounds", () => {
		const screenshotRound = (id: string, data: string) => [
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool_use" as const,
						id,
						name: "Read",
						input: { path: `${id}.png` },
					},
				],
			},
			{
				role: "user" as const,
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: id,
						content: [
							{
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: "image/png",
									data,
								},
							},
						],
					},
				],
			},
		];

		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{ role: "user", content: "first" },
					...screenshotRound("t1", "FIRST"),
					{ role: "assistant", content: "looked at first" },
					...screenshotRound("t2", "SECOND"),
					{ role: "user", content: [{ type: "text", text: "compare" }] },
				],
			}),
		);

		// Roles must read: user, assistant(tool_calls), tool, user(image),
		// assistant, assistant(tool_calls), tool, user(image), user("compare").
		// The image turn must follow its OWN tool message, never trail the
		// conversation.
		expect(result.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
			"assistant",
			"assistant",
			"tool",
			"user",
			"user",
		]);

		expect(result.messages[3]?.content).toEqual([
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,FIRST" },
			},
		]);
		expect(result.messages[7]?.content).toEqual([
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,SECOND" },
			},
		]);
		// The final turn is the client's own text, not a trailing image blob.
		expect(result.messages[8]?.content).toBe("compare");
	});

	it("keeps every tool message adjacent when several results carry images", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "tool_use", id: "t1", name: "Read", input: {} },
							{ type: "tool_use", id: "t2", name: "Read", input: {} },
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "t1",
								content: [
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "FIRST",
										},
									},
								],
							},
							{
								type: "tool_result",
								tool_use_id: "t2",
								content: [
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "SECOND",
										},
									},
								],
							},
						],
					},
				],
			}),
		);

		// Both `tool` messages answer the same assistant turn, so they must stay
		// adjacent. A user turn between them would answer t1 to the tool_calls
		// message and orphan t2's tool_call_id.
		expect(result.messages.map((m) => m.role)).toEqual([
			"assistant",
			"tool",
			"tool",
			"user",
		]);
		// The single hoisted turn carries both images, in tool_result order.
		expect(result.messages[3]?.content).toEqual([
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,FIRST" },
			},
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,SECOND" },
			},
		]);
	});

	// The mapper returns null for a block with no data and no url, so nothing is
	// hoisted. The placeholder must then say the image is missing rather than
	// point at a following message that carries somebody else's image (or none).
	it("says the image is unavailable when its block has no usable source", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "t1",
								content: [{ type: "image", source: {} }],
							},
							{
								type: "tool_result",
								tool_use_id: "t2",
								content: [
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "REAL",
										},
									},
								],
							},
						],
					},
				],
			}),
		);

		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs[0]?.content).toBe(
			"[image unavailable: the tool result carried none]",
		);
		// The real image still points correctly and is the only thing hoisted.
		expect(toolMsgs[1]?.content).toBe(
			"[image attached in the following message]",
		);
		expect(result.messages[result.messages.length - 1]?.content).toEqual([
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,REAL" },
			},
		]);
	});

	it("does not add a user turn when no tool result carries an image", () => {
		const before = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_2",
								content: "plain output",
							},
						],
					},
				],
			}),
		);
		expect(before.messages.some((m) => Array.isArray(m.content))).toBe(false);
	});
});
