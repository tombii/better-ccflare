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
			"[image content not supported in OpenAI tool results]",
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
