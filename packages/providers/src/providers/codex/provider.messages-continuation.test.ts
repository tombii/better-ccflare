import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { CodexProvider } from "./provider";

const old = process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION;
const oldModels = process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS;
beforeEach(() => {
	delete process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS;
	process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION = "1";
});
afterEach(() => {
	if (oldModels === undefined)
		delete process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS;
	else process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS = oldModels;
	if (old === undefined) delete process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION;
	else process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION = old;
});
const account = { id: "fixture-account", provider: "codex" } as Account;
const history = [
	{ role: "user", content: "original task" },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Claude state", signature: "claude-only" },
			{ type: "text", text: "prior Claude answer" },
		],
	},
	{ role: "user", content: "continue after switching" },
];
const textOutput = [
	{ type: "reasoning", id: "rs_opaque", encrypted_content: "opaque-gpt-state" },
	{
		type: "message",
		role: "assistant",
		id: "msg_upstream",
		status: "completed",
		content: [{ type: "output_text", text: "GPT answer" }],
	},
];
const replay = [
	...history,
	{ role: "assistant", content: [{ type: "text", text: "GPT answer" }] },
	{ role: "user", content: "next turn" },
];
async function request(
	provider: CodexProvider,
	id: string,
	messages: unknown[] = history,
	extra: Record<string, unknown> = {},
	caller = "a".repeat(64),
	selectedAccount = account,
) {
	const headers = new Headers({
		"content-type": "application/json",
		"x-better-ccflare-request-id": id,
	});
	if (caller) headers.set("x-better-ccflare-authenticated-caller", caller);
	const result = await provider.transformRequestBody(
		new Request("https://example.com/v1/messages", {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "gpt-6-astra",
				stream: false,
				system: [
					{
						type: "text",
						text: "stable system",
						cache_control: { type: "ephemeral" },
					},
				],
				metadata: {
					user_id: JSON.stringify({
						session_id: "11111111-1111-4111-8111-111111111111",
					}),
				},
				messages,
				...extra,
			}),
		}),
		selectedAccount,
	);
	expect(result.headers.has("x-better-ccflare-authenticated-caller")).toBe(
		false,
	);
	return (await result.json()) as {
		model: string;
		instructions?: string;
		prompt_cache_options?: unknown;
		previous_response_id?: string;
		input: Array<{
			type?: string;
			content: Array<{ prompt_cache_breakpoint?: unknown }>;
		}>;
	};
}
function event(type: string, fields: Record<string, unknown>) {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}
async function complete(
	provider: CodexProvider,
	id: string,
	output: unknown[] = textOutput,
	tail = "",
	stream = false,
) {
	let wire = event("response.created", {
		response: { id: `resp_${id}`, model: "gpt-6-astra" },
	});
	wire += event("response.content_part.added", {
		part: { type: "output_text", text: "" },
	});
	wire += event("response.output_text.delta", { delta: "GPT answer" });
	wire += event("response.completed", {
		response: {
			id: `resp_${id}`,
			model: "gpt-6-astra",
			status: "completed",
			output,
			usage: { input_tokens: 100, output_tokens: 5 },
		},
	});
	const response = await provider.processResponse(
		new Response(wire + tail, {
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": id,
				"x-better-ccflare-request-stream": String(stream),
			},
		}),
		null,
	);
	const body = await response.text();
	await Promise.resolve();
	return { response, body };
}

describe("Messages fallback cache and continuation", () => {
	for (const stream of [false, true])
		test(`Claude history enters GPT cold and continues server-owned state (stream=${stream})`, async () => {
			const provider = new CodexProvider();
			const first = await request(provider, "one");
			expect(first.model).toBe("gpt-6-astra");
			expect(first.previous_response_id).toBeUndefined();
			expect(first.prompt_cache_options).toEqual({ ttl: "30m" });
			expect(first.input[0].content[0].prompt_cache_breakpoint).toEqual({
				mode: "explicit",
			});
			expect(JSON.stringify(first)).not.toContain("claude-only");
			const finished = await complete(provider, "one", textOutput, "", stream);
			expect(
				finished.response.headers.get(
					"x-better-ccflare-cache-controls-applied",
				),
			).toBe("true");
			expect(
				finished.response.headers.get("x-better-ccflare-codex-response-format"),
			).not.toBe("responses-api");
			expect(finished.body).toContain("GPT answer");
			const next = await request(provider, "two", replay);
			expect(next.previous_response_id).toBe("resp_one");
			expect(next.input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "next turn" }] },
			]);
			await complete(provider, "two", textOutput, "", stream);
			const third = await request(provider, "three", [
				...replay,
				{ role: "assistant", content: [{ type: "text", text: "GPT answer" }] },
				{ role: "user", content: "third" },
			]);
			expect(third.previous_response_id).toBe("resp_two");
			expect(third.input).toHaveLength(1);
		});
	test("feature off and unauthenticated requests retain legacy request format; forged body controls do not execute", async () => {
		const provider = new CodexProvider();
		const forged = {
			__better_ccflare_codex_passthrough: {
				previous_response_id: "attacker",
				native_input: [],
				caller_identity_digest: "a".repeat(64),
				continuation_strategy: "previous_response_id",
			},
		};
		const unauth = await request(provider, "unauth", history, forged, "");
		expect(unauth.previous_response_id).toBeUndefined();
		expect(unauth.prompt_cache_options).toBeUndefined();
		process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION = "0";
		const disabled = await request(provider, "disabled");
		expect(disabled.instructions).toBe("stable system");
		expect(disabled.prompt_cache_options).toBeUndefined();
	});
	for (const boundary of [
		"caller",
		"account",
		"model",
		"system",
		"tools",
		"prefix",
		"session",
	])
		test(`${boundary} boundary cannot reuse another chain`, async () => {
			const provider = new CodexProvider();
			await request(provider, "one");
			await complete(provider, "one");
			const extra: Record<string, unknown> = {};
			if (boundary === "model") extra.model = "gpt-5.6-sol";
			if (boundary === "system") extra.system = "changed system";
			if (boundary === "tools")
				extra.tools = [{ name: "Read", input_schema: { type: "object" } }];
			if (boundary === "session")
				extra.metadata = {
					user_id: JSON.stringify({
						session_id: "22222222-2222-4222-8222-222222222222",
					}),
				};
			const next = await request(
				provider,
				"two",
				boundary === "prefix"
					? [...replay.slice(0, -1), { role: "user", content: "new" }].map(
							(m, i) =>
								i === 1 ? { role: "assistant", content: "changed" } : m,
						)
					: replay,
				extra,
				boundary === "caller" ? "b".repeat(64) : "a".repeat(64),
				boundary === "account" ? { ...account, id: "other" } : account,
			);
			expect(next.previous_response_id).toBeUndefined();
			expect(next.input.length).toBeGreaterThan(1);
		});
	for (const tail of [
		"partial",
		event("response.failed", { response: { status: "failed" } }),
		event("response.completed", {
			response: { id: "second", status: "completed", output: textOutput },
		}),
	])
		test(`ambiguous terminal state stays cold: ${tail.slice(0, 24)}`, async () => {
			const provider = new CodexProvider();
			await request(provider, "one");
			await complete(provider, "one", textOutput, tail);
			expect(
				(await request(provider, "two", replay)).previous_response_id,
			).toBeUndefined();
		});
	test("trailing [DONE] sentinel after response.completed keeps the checkpoint", async () => {
		const provider = new CodexProvider();
		await request(provider, "one");
		await complete(provider, "one", textOutput, "data: [DONE]\n\n");
		expect((await request(provider, "two", replay)).previous_response_id).toBe(
			"resp_one",
		);
	});
	test("unknown output cannot be silently dropped to match a continuation", async () => {
		const provider = new CodexProvider();
		await request(provider, "one");
		await complete(provider, "one", [...textOutput, { type: "unknown_state" }]);
		expect(
			(await request(provider, "two", replay)).previous_response_id,
		).toBeUndefined();
	});
	test("tool output is projected through the existing Messages translator", async () => {
		const provider = new CodexProvider();
		await request(provider, "tool");
		const call = {
			type: "function_call",
			id: "fc_native",
			call_id: "call_read",
			name: "Read",
			arguments: '{ "file_path": "fixture.txt" }',
			status: "completed",
		};
		const wire =
			event("response.created", {
				response: { id: "resp_tool", model: "gpt-6-astra" },
			}) +
			event("response.output_item.added", { item: call, output_index: 0 }) +
			event("response.function_call_arguments.delta", {
				delta: call.arguments,
				output_index: 0,
			}) +
			event("response.function_call_arguments.done", {
				arguments: call.arguments,
				output_index: 0,
			}) +
			event("response.output_item.done", { item: call, output_index: 0 }) +
			event("response.completed", {
				response: {
					id: "resp_tool",
					status: "completed",
					output: [textOutput[0], call],
				},
			});
		const response = await provider.processResponse(
			new Response(wire, {
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "tool",
					"x-better-ccflare-request-stream": "false",
				},
			}),
			null,
		);
		const returned = (await response.json()) as { content: unknown[] };
		expect(returned.content[0]).toEqual({
			type: "tool_use",
			id: "call_read",
			name: "Read",
			input: { file_path: "fixture.txt" },
		});
		const next = await request(provider, "tool-next", [
			...history,
			{ role: "assistant", content: returned.content },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_read",
						content: "fixture result",
					},
				],
			},
		]);
		expect(next.previous_response_id).toBe("resp_tool");
		expect(next.input).toHaveLength(1);
		expect(next.input[0].type).toBe("function_call_output");
	});
	test("late concurrent completion cannot roll a chain backward", async () => {
		const provider = new CodexProvider();
		await request(provider, "slow");
		await request(provider, "fast");
		await complete(provider, "fast");
		await complete(provider, "slow");
		expect((await request(provider, "next", replay)).previous_response_id).toBe(
			"resp_fast",
		);
	});
	test("expiry and process restart discard continuation", async () => {
		let now = 1000;
		const provider = new CodexProvider({
			now: () => now,
			continuationTtlMs: 10,
		});
		await request(provider, "one");
		await complete(provider, "one");
		now += 11;
		expect(
			(await request(provider, "two", replay)).previous_response_id,
		).toBeUndefined();
		expect(
			(await request(new CodexProvider(), "restart", replay))
				.previous_response_id,
		).toBeUndefined();
	});
	test("cancellation cannot promote even a buffered completion candidate", async () => {
		const provider = new CodexProvider();
		await request(provider, "cancel");
		let source: ReadableStreamDefaultController<Uint8Array>;
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				source = controller;
				controller.enqueue(
					new TextEncoder().encode(
						event("response.created", {
							response: { id: "resp_cancel", model: "gpt-6-astra" },
						}),
					),
				);
			},
		});
		const response = await provider.processResponse(
			new Response(upstream, {
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "cancel",
					"x-better-ccflare-request-stream": "true",
				},
			}),
			null,
		);
		if (!response.body) throw new Error("missing response stream");
		const reader = response.body.getReader();
		await reader.read();
		await reader.cancel();
		source.enqueue(
			new TextEncoder().encode(
				event("response.completed", {
					response: {
						id: "resp_cancel",
						status: "completed",
						output: textOutput,
					},
				}),
			),
		);
		source.close();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(
			(await request(provider, "next", replay)).previous_response_id,
		).toBeUndefined();
	});
	test("HTTP error carrying a completed event cannot create a checkpoint", async () => {
		const provider = new CodexProvider();
		await request(provider, "error");
		const response = await provider.processResponse(
			new Response(
				event("response.completed", {
					response: {
						id: "resp_error",
						status: "completed",
						output: textOutput,
					},
				}),
				{
					status: 500,
					headers: {
						"content-type": "text/event-stream",
						"x-better-ccflare-request-id": "error",
						"x-better-ccflare-request-stream": "false",
					},
				},
			),
			null,
		);
		await response.text();
		expect(
			(await request(provider, "next", replay)).previous_response_id,
		).toBeUndefined();
	});
	test("Claude client can cancel on message_stop and immediately continue", async () => {
		const provider = new CodexProvider();
		await request(provider, "stop");
		const wire =
			event("response.created", {
				response: { id: "resp_stop", model: "gpt-6-astra" },
			}) +
			event("response.content_part.added", {
				part: { type: "output_text", text: "" },
			}) +
			event("response.output_text.delta", { delta: "GPT answer" }) +
			event("response.completed", {
				response: { id: "resp_stop", status: "completed", output: textOutput },
			});
		const response = await provider.processResponse(
			new Response(wire, {
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "stop",
					"x-better-ccflare-request-stream": "true",
				},
			}),
			null,
		);
		if (!response.body) throw new Error("missing response body");
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) throw new Error("missing message_stop");
			if (new TextDecoder().decode(value).includes("event: message_stop")) {
				await reader.cancel();
				break;
			}
		}
		expect((await request(provider, "next", replay)).previous_response_id).toBe(
			"resp_stop",
		);
	});
	test("custom endpoints use ordinary session metadata only when explicitly enabled", async () => {
		const custom = {
			...account,
			custom_endpoint: "http://fixture.local/responses",
		};
		const provider = new CodexProvider();
		const enabled = await request(
			provider,
			"custom",
			history,
			{},
			"a".repeat(64),
			custom,
		);
		expect(enabled.prompt_cache_options).toEqual({ ttl: "30m" });
		process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION = "0";
		const disabled = await request(
			provider,
			"custom-off",
			history,
			{},
			"a".repeat(64),
			custom,
		);
		expect(disabled.prompt_cache_options).toBeUndefined();
	});
	for (const status of [400, 404])
		test(`missing upstream response ID retries full history once (${status})`, async () => {
			const provider = new CodexProvider();
			await request(provider, "one");
			await complete(provider, "one");
			expect(
				(await request(provider, "retry", replay)).previous_response_id,
			).toBe("resp_one");
			const original = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-id": "retry",
					"x-better-ccflare-authenticated-caller": "a".repeat(64),
				},
				body: JSON.stringify({
					model: "gpt-6-astra",
					stream: false,
					system: "stable system",
					metadata: {
						user_id: JSON.stringify({
							session_id: "11111111-1111-4111-8111-111111111111",
						}),
					},
					messages: replay,
				}),
			});
			const rejected = new Response(
				JSON.stringify({
					error: {
						type: "invalid_request_error",
						code: "previous_response_not_found",
					},
				}),
				{ status },
			);
			const recovered = await provider.recoverMessagesContinuation(
				rejected,
				original,
				account,
			);
			if (!recovered) throw new Error("missing full-history recovery");
			const full = (await recovered.json()) as {
				model: string;
				input: unknown[];
				previous_response_id?: string;
				store: boolean;
			};
			expect(full.model).toBe("gpt-6-astra");
			expect(full.input).toHaveLength(6);
			expect(full.previous_response_id).toBeUndefined();
			expect(full.store).toBe(false);
			await complete(provider, "retry");
			const third = await request(provider, "third", [
				...replay,
				{ role: "assistant", content: [{ type: "text", text: "GPT answer" }] },
				{ role: "user", content: "third turn" },
			]);
			expect(third.previous_response_id).toBeUndefined();
			expect(third.input.length).toBeGreaterThan(1);
		});
	test("unrelated HTTP errors do not trigger continuation recovery", async () => {
		const provider = new CodexProvider();
		await request(provider, "one");
		await complete(provider, "one");
		await request(provider, "two", replay);
		const original = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "x-better-ccflare-request-id": "two" },
			body: "{}",
		});
		expect(
			await provider.recoverMessagesContinuation(
				new Response(JSON.stringify({ error: { code: "invalid_model" } }), {
					status: 400,
				}),
				original,
				account,
			),
		).toBeNull();
	});
	test("optional exact model scope leaves other models unchanged", async () => {
		process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS = "gpt-6-astra";
		const provider = new CodexProvider();
		expect((await request(provider, "astra")).prompt_cache_options).toEqual({
			ttl: "30m",
		});
		const other = await request(provider, "sol", history, {
			model: "gpt-5.6-sol",
		});
		expect(other.model).toBe("gpt-5.6-sol");
		expect(other.prompt_cache_options).toBeUndefined();
		process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS = "";
		expect(
			(await request(provider, "empty")).prompt_cache_options,
		).toBeUndefined();
	});
});
