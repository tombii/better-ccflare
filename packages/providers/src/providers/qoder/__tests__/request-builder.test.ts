import { describe, expect, it } from "bun:test";
import {
	buildQoderRequest,
	QODER_DEFAULT_MAX_OUTPUT_TOKENS,
	type QoderRequestBody,
} from "../request-builder";

function anthropic(overrides: Record<string, unknown> = {}) {
	return {
		model: "qfmodel",
		max_tokens: 1024,
		messages: [{ role: "user", content: "Hello there" }],
		...overrides,
	};
}

function lastUserText(body: QoderRequestBody): string {
	return body.chat_context.extra.originalContent;
}

describe("buildQoderRequest", () => {
	describe("envelope members", () => {
		it("emits every required member with the documented values", () => {
			const body = buildQoderRequest(anthropic());
			expect(body.chat_task).toBe("FREE_INPUT");
			expect(body.is_reply).toBe(true);
			expect(body.is_retry).toBe(false);
			expect(body.source).toBe(1);
			expect(body.version).toBe("3");
			expect(body.session_type).toBe("qodercli");
			expect(body.agent_id).toBe("agent_common");
			expect(body.task_id).toBe("common");
			expect(body.code_language).toBe("");
			expect(body.chat_prompt).toBe("");
			expect(body.image_urls).toBeNull();
			expect(body.aliyun_user_type).toBe("");
			expect(body.stream).toBe(true);
			expect(body.request_id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
			expect(body.request_set_id).toMatch(/^[0-9a-f]{16}$/);
			expect(body.chat_record_id).toBe(body.request_set_id);
			expect(body.session_id).toMatch(/^[0-9a-f]{16}$/);
		});

		it("is deterministic in the conversation ids but fresh in the per-request ids", () => {
			const a = buildQoderRequest(anthropic());
			const b = buildQoderRequest(anthropic());
			expect(a.session_id).toBe(b.session_id);
			expect(a.request_set_id).toBe(b.request_set_id);
			expect(a.request_id).not.toBe(b.request_id);
			expect(a.business.id).not.toBe(b.business.id);
		});

		it("gives a different conversation a different id", () => {
			const a = buildQoderRequest(anthropic());
			const b = buildQoderRequest(
				anthropic({
					messages: [{ role: "user", content: "something else entirely" }],
				}),
			);
			expect(a.request_set_id).not.toBe(b.request_set_id);
		});
	});

	describe("model key", () => {
		it("puts the wire key in both modelConfig and model_config", () => {
			const body = buildQoderRequest(anthropic({ model: "dfmodel" }));
			expect(body.chat_context.extra.modelConfig.key).toBe("dfmodel");
			expect(body.model_config.key).toBe("dfmodel");
		});

		it("marks reasoning models and flags the source as system", () => {
			const body = buildQoderRequest(anthropic({ model: "qfmodel" }));
			expect(body.model_config.source).toBe("system");
			expect(body.model_config.is_reasoning).toBe(true);
			expect(body.chat_context.extra.modelConfig.is_reasoning).toBe(true);
		});

		it("rejects a Claude model id rather than sending it upstream", () => {
			expect(() =>
				buildQoderRequest(anthropic({ model: "claude-sonnet-4-5" })),
			).toThrow(/model/i);
		});
	});

	describe("parameters", () => {
		it("carries max_tokens and caps output at 32768", () => {
			expect(
				buildQoderRequest(anthropic({ max_tokens: 1024 })).parameters
					.max_tokens,
			).toBe(1024);
			const huge = buildQoderRequest(anthropic({ max_tokens: 1_000_000 }));
			expect(huge.parameters.max_tokens).toBe(QODER_DEFAULT_MAX_OUTPUT_TOKENS);
			expect(QODER_DEFAULT_MAX_OUTPUT_TOKENS).toBe(32768);
		});

		it("passes max_output_tokens on model_config", () => {
			const body = buildQoderRequest(anthropic({ max_tokens: 2048 }));
			expect(body.model_config.max_output_tokens).toBe(2048);
		});

		it("maps temperature, top_p and stop_sequences", () => {
			const body = buildQoderRequest(
				anthropic({
					temperature: 0.3,
					top_p: 0.9,
					stop_sequences: ["\n\nHuman:"],
				}),
			);
			expect(body.parameters.temperature).toBe(0.3);
			expect(body.parameters.top_p).toBe(0.9);
			expect(body.parameters.stop).toEqual(["\n\nHuman:"]);
		});

		it("omits optional parameters the client did not send", () => {
			const body = buildQoderRequest({
				model: "qfmodel",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(body.parameters.max_tokens).toBe(QODER_DEFAULT_MAX_OUTPUT_TOKENS);
			expect(body.parameters).not.toHaveProperty("temperature");
			expect(body.parameters).not.toHaveProperty("top_p");
			expect(body.parameters).not.toHaveProperty("stop");
		});
	});

	describe("system prompt", () => {
		it("lifts a string system prompt to the top-level system member", () => {
			const body = buildQoderRequest(anthropic({ system: "You are terse." }));
			expect(body.system).toBe("You are terse.");
			expect(body.messages.some((m) => m.role === "system")).toBe(false);
		});

		it("joins text blocks and ignores cache_control markers", () => {
			const body = buildQoderRequest(
				anthropic({
					system: [
						{
							type: "text",
							text: "Part one.",
							cache_control: { type: "ephemeral" },
						},
						{ type: "text", text: "Part two." },
					],
				}),
			);
			expect(body.system).toBe("Part one.Part two.");
		});

		it("is empty when the client sent no system prompt", () => {
			expect(buildQoderRequest(anthropic()).system).toBe("");
		});
	});

	describe("message mapping", () => {
		it("maps string-content turns to plain role/content pairs", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "one" },
						{ role: "assistant", content: "two" },
						{ role: "user", content: "three" },
					],
				}),
			);
			expect(body.messages).toEqual([
				{ role: "user", content: "one" },
				{ role: "assistant", content: "two" },
				{ role: "user", content: "three" },
			]);
		});

		it("duplicates the last user text into chat_context.text and originalContent", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "first" },
						{ role: "assistant", content: "reply" },
						{
							role: "user",
							content: [{ type: "text", text: "the last question" }],
						},
					],
				}),
			);
			expect(lastUserText(body)).toBe("the last question");
			expect(body.chat_context.text).toBe("the last question");
			expect(body.chat_context.chatPrompt).toBe("");
			expect(body.chat_context.imageUrls).toBeNull();
			expect(body.chat_context.extra.context).toEqual([]);
			expect(body.chat_context.features).toEqual([]);
		});

		it("uses the last user turn even when an assistant turn is last", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "question" },
						{ role: "assistant", content: "prefill" },
					],
				}),
			);
			expect(lastUserText(body)).toBe("question");
		});

		it("maps assistant tool_use to OpenAI tool_calls with a JSON argument string", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "list files" },
						{
							role: "assistant",
							content: [
								{ type: "text", text: "Checking." },
								{
									type: "tool_use",
									id: "toolu_1",
									name: "Bash",
									input: { command: "ls" },
								},
							],
						},
					],
				}),
			);
			const assistant = body.messages[1];
			expect(assistant.role).toBe("assistant");
			expect(assistant.content).toBe("Checking.");
			expect(assistant.tool_calls).toEqual([
				{
					id: "toolu_1",
					type: "function",
					function: { name: "Bash", arguments: '{"command":"ls"}' },
				},
			]);
		});

		it("emits a tool_use-only assistant turn with an empty content string", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "go" },
						{
							role: "assistant",
							content: [
								{ type: "tool_use", id: "t1", name: "Read", input: {} },
							],
						},
					],
				}),
			);
			expect(body.messages[1]).toEqual({
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "t1",
						type: "function",
						function: { name: "Read", arguments: "{}" },
					},
				],
			});
		});

		it("maps tool_result to a tool message answering the matching call", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "list files" },
						{
							role: "assistant",
							content: [
								{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
							],
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "toolu_1",
									content: "a.txt",
								},
							],
						},
					],
				}),
			);
			expect(body.messages[2]).toEqual({
				role: "tool",
				tool_call_id: "toolu_1",
				content: "a.txt",
			});
		});

		it("serialises array tool_result content and marks images as unsupported", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "go" },
						{
							role: "assistant",
							content: [
								{ type: "tool_use", id: "t1", name: "View", input: {} },
							],
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "t1",
									content: [
										{ type: "text", text: "line one" },
										{
											type: "image",
											source: { type: "base64", data: "AAA" },
										},
									],
								},
							],
						},
					],
				}),
			);
			expect(body.messages[2].content).toBe(
				"line one\n[image content not supported in OpenAI tool results]",
			);
		});

		it("matches a result with a lost id to the outstanding call in order", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "go" },
						{
							role: "assistant",
							content: [
								{ type: "tool_use", id: "t1", name: "A", input: {} },
								{ type: "tool_use", id: "t2", name: "B", input: {} },
							],
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "unknown-1",
									content: "r1",
								},
								{ type: "tool_result", content: "r2" },
							],
						},
					],
				}),
			);
			const tools = body.messages.filter((m) => m.role === "tool");
			expect(tools.map((t) => t.tool_call_id)).toEqual(["t1", "t2"]);
		});

		it("does not let a result answer a call made after it", () => {
			// Qoder refuses "a result that answers no call before it", so a result
			// naming a call that comes later in the conversation is not a match:
			// it takes the oldest outstanding call instead.
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "go" },
						{
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "later", content: "r" },
							],
						},
						{
							role: "assistant",
							content: [
								{ type: "tool_use", id: "later", name: "A", input: {} },
							],
						},
					],
				}),
			);
			// No call precedes the result, so it has no call to answer and goes
			// out as text in a user turn.
			expect(body.messages.some((m) => m.role === "tool")).toBe(false);
			expect(
				body.messages.some(
					(m) => m.role === "user" && String(m.content).includes("r"),
				),
			).toBe(true);
		});

		it("sends an unanswerable tool_result as text in the user turn", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "go" },
						{
							role: "assistant",
							content: [{ type: "tool_use", id: "t1", name: "A", input: {} }],
						},
						{
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "t1", content: "r1" },
							],
						},
						{ role: "assistant", content: "done" },
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "orphan",
									content: "stray",
								},
								{ type: "text", text: "and now?" },
							],
						},
					],
				}),
			);
			const last = body.messages[body.messages.length - 1];
			expect(last.role).toBe("user");
			expect(body.messages.some((m) => m.tool_call_id === "orphan")).toBe(
				false,
			);
			expect(String(last.content)).toContain("stray");
			expect(String(last.content)).toContain("and now?");
		});

		it("maps thinking blocks to reasoning_content on the assistant turn", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "q" },
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "hmm" },
								{ type: "text", text: "answer" },
							],
						},
					],
				}),
			);
			expect(body.messages[1].reasoning_content).toBe("hmm");
			expect(body.messages[1].content).toBe("answer");
		});

		it("keeps a thinking-only assistant turn", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "q" },
						{
							role: "assistant",
							content: [{ type: "thinking", thinking: "hmm" }],
						},
					],
				}),
			);
			expect(body.messages[1]).toEqual({
				role: "assistant",
				content: "",
				reasoning_content: "hmm",
			});
		});

		it("never emits an empty message", () => {
			const body = buildQoderRequest(
				anthropic({
					messages: [
						{ role: "user", content: "q" },
						{ role: "assistant", content: [{ type: "text", text: "" }] },
					],
				}),
			);
			expect(body.messages).toHaveLength(1);
		});
	});

	describe("tools", () => {
		it("maps Anthropic input_schema onto OpenAI parameters", () => {
			const body = buildQoderRequest(
				anthropic({
					tools: [
						{
							name: "Bash",
							description: "Run a shell command",
							input_schema: {
								type: "object",
								properties: { command: { type: "string" } },
								required: ["command"],
							},
						},
					],
				}),
			);
			expect(body.tools).toEqual([
				{
					type: "function",
					function: {
						name: "Bash",
						description: "Run a shell command",
						parameters: {
							type: "object",
							properties: { command: { type: "string" } },
							required: ["command"],
						},
					},
				},
			]);
		});

		it("emits an empty tools array when there are none", () => {
			expect(buildQoderRequest(anthropic()).tools).toEqual([]);
		});

		it("maps tool_choice to an OpenAI shape", () => {
			const tools = [{ name: "Bash", input_schema: { type: "object" } }];
			expect(
				buildQoderRequest(anthropic({ tools, tool_choice: { type: "any" } }))
					.tool_choice,
			).toBe("required");
			expect(
				buildQoderRequest(
					anthropic({ tools, tool_choice: { type: "tool", name: "Bash" } }),
				).tool_choice,
			).toEqual({ type: "function", function: { name: "Bash" } });
			expect(
				buildQoderRequest(anthropic({ tools, tool_choice: { type: "none" } }))
					.tool_choice,
			).toBe("none");
			expect(
				buildQoderRequest(anthropic({ tools, tool_choice: { type: "auto" } }))
					.tool_choice,
			).toBe("auto");
		});

		it("drops a tool_choice the client sent without tools", () => {
			const body = buildQoderRequest(
				anthropic({ tool_choice: { type: "any" } }),
			);
			expect(body).not.toHaveProperty("tool_choice");
		});
	});

	describe("business block", () => {
		it("names the business from the last user text, capped at 30 chars", () => {
			const text = "x".repeat(50);
			const body = buildQoderRequest(
				anthropic({ messages: [{ role: "user", content: text }] }),
			);
			expect(body.business.name).toBe("x".repeat(30));
			expect(body.business.product).toBe("cli");
			expect(body.business.version).toBe("1.0.0");
			expect(body.business.type).toBe("agent");
			expect(body.business.stage).toBe("start");
			expect(typeof body.business.begin_at).toBe("number");
			expect(body.business.begin_at).toBeGreaterThan(1e12);
		});
	});

	describe("reasoning effort", () => {
		it("maps Anthropic thinking budget to a Qoder reasoning effort", () => {
			const body = buildQoderRequest(
				anthropic({
					thinking: { type: "enabled", budget_tokens: 4096 },
				}),
			);
			expect(body.model_config.is_reasoning).toBe(true);
			expect(["low", "medium", "high", "max", "xhigh"]).toContain(
				body.model_config.reasoning_effort as string,
			);
		});

		it("disables reasoning when the client explicitly turns thinking off", () => {
			const body = buildQoderRequest(
				anthropic({ thinking: { type: "disabled" } }),
			);
			expect(body.model_config.is_reasoning).toBe(false);
			expect(body.chat_context.extra.modelConfig.is_reasoning).toBe(false);
		});
	});
});
