import { describe, expect, test } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import { getTranslatedToolName } from "../custom-tools";
import { translateAnthropicStreamToResponses } from "../stream-translator";

async function collectSseEvents(
	response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
	const text = await response.text();
	const events: Array<{ event: string; data: unknown }> = [];
	const rawEvents = text.split(/\r?\n\r?\n/).filter((s) => s.trim().length > 0);

	for (const rawEvent of rawEvents) {
		const lines = rawEvent.split(/\r?\n/);
		let eventType = "message";
		let dataStr = "";
		for (const line of lines) {
			if (line.startsWith("event: ")) {
				eventType = line.slice(7).trim();
			} else if (line.startsWith("data: ")) {
				dataStr = line.slice(6).trim();
			}
		}
		if (dataStr) {
			events.push({ event: eventType, data: JSON.parse(dataStr) });
		}
	}

	return events;
}

function makeAnthropicStream(eventStrings: string[]): Response {
	const body = `${eventStrings.join("\n\n")}\n\n`;
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function sseEvent(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}`;
}

describe("translateAnthropicStreamToResponses", () => {
	test("namespaced custom and function calls restore name and namespace in SSE", async () => {
		const events = [
			sseEvent("message_start", { message: { id: "msg_namespaces" } }),
		];
		for (const [index, name, namespace, input] of [
			[0, "exec", "functions", { input: "text(1)" }],
			[1, "wait", "clock", { duration_ms: 10 }],
		] as const) {
			events.push(
				sseEvent("content_block_start", {
					index,
					content_block: {
						type: "tool_use",
						id: `call_${index}`,
						name: getTranslatedToolName(name, namespace),
						input: {},
					},
				}),
				sseEvent("content_block_delta", {
					index,
					delta: {
						type: "input_json_delta",
						partial_json: JSON.stringify(input),
					},
				}),
				sseEvent("content_block_stop", { index }),
			);
		}
		events.push(sseEvent("message_stop", {}));
		const parsed = await collectSseEvents(
			translateAnthropicStreamToResponses(
				makeAnthropicStream(events),
				"resp_namespaces",
				"gpt-6-astra",
				[
					{
						type: "namespace",
						name: "functions",
						tools: [{ type: "custom", name: "exec" }],
					},
					{
						type: "namespace",
						name: "clock",
						tools: [{ type: "function", name: "wait" }],
					},
				],
			),
		);
		for (const eventType of [
			"response.output_item.added",
			"response.output_item.done",
		]) {
			const items = parsed.filter((event) => event.event === eventType);
			expect(items[0].data).toMatchObject({
				item: {
					type: "custom_tool_call",
					name: "exec",
					namespace: "functions",
				},
			});
			expect(items[1].data).toMatchObject({
				item: { type: "function_call", name: "wait", namespace: "clock" },
			});
		}
		expect(parsed.at(-1)?.data).toMatchObject({
			response: {
				output: [
					{
						type: "custom_tool_call",
						name: "exec",
						namespace: "functions",
						input: "text(1)",
					},
					{
						type: "function_call",
						name: "wait",
						namespace: "clock",
						arguments: '{"duration_ms":10}',
					},
				],
			},
		});
	});

	test("custom tool SSE decodes split JSON escapes into raw input and complete output", async () => {
		const patch =
			'*** Begin Patch\n*** Add File: hello.txt\n+"héllo" \\ 🚀\n*** End Patch';
		const json = JSON.stringify({ input: patch }).replace(
			"🚀",
			"\\ud83d\\ude80",
		);
		const events = [
			sseEvent("message_start", {
				message: { id: "msg_custom", usage: { input_tokens: 12 } },
			}),
			sseEvent("content_block_start", {
				index: 0,
				content_block: {
					type: "tool_use",
					id: "call_patch",
					name: "apply_patch",
					input: {},
				},
			}),
			...Array.from(json, (partial_json) =>
				sseEvent("content_block_delta", {
					index: 0,
					delta: { type: "input_json_delta", partial_json },
				}),
			),
			sseEvent("content_block_stop", { index: 0 }),
			sseEvent("message_delta", { usage: { output_tokens: 30 } }),
			sseEvent("message_stop", {}),
		];
		const parsed = await collectSseEvents(
			translateAnthropicStreamToResponses(
				makeAnthropicStream(events),
				"resp_custom",
				"gpt-5.4",
				[{ type: "custom", name: "apply_patch" }],
			),
		);
		expect(parsed.map((event) => event.event)).toEqual([
			"response.created",
			"response.in_progress",
			"response.output_item.added",
			"response.custom_tool_call_input.delta",
			"response.custom_tool_call_input.done",
			"response.output_item.done",
			"response.completed",
		]);
		expect(parsed[2].data).toMatchObject({
			item: {
				type: "custom_tool_call",
				call_id: "call_patch",
				name: "apply_patch",
				input: "",
			},
		});
		expect(parsed[3].data).toMatchObject({
			delta: patch,
			call_id: "call_patch",
		});
		expect(parsed[4].data).toMatchObject({ input: patch });
		const completedItem = {
			type: "custom_tool_call",
			id: "resp_custom_ctc_0",
			call_id: "call_patch",
			name: "apply_patch",
			input: patch,
			status: "completed",
		};
		expect(parsed[5].data).toMatchObject({ item: completedItem });
		expect(parsed[6].data).toMatchObject({
			response: { output: [completedItem] },
		});
	});

	test("custom tool SSE accepts initial input and fails malformed input without completing a call", async () => {
		for (const input of [
			{ input: "" },
			{ input: "complete patch" },
			{ input: 42 },
		]) {
			const parsed = await collectSseEvents(
				translateAnthropicStreamToResponses(
					makeAnthropicStream([
						sseEvent("message_start", { message: { id: "msg_custom" } }),
						sseEvent("content_block_start", {
							index: 0,
							content_block: {
								type: "tool_use",
								id: "call_patch",
								name: "apply_patch",
								input,
							},
						}),
						sseEvent("content_block_stop", { index: 0 }),
						sseEvent("message_stop", {}),
					]),
					"resp_custom",
					"gpt-5.4",
					[{ type: "custom", name: "apply_patch" }],
				),
			);
			if (typeof input.input === "string") {
				expect(
					parsed.find((event) => event.event === "response.output_item.done")
						?.data,
				).toMatchObject({
					item: { type: "custom_tool_call", input: input.input },
				});
				expect(parsed.at(-1)?.event).toBe("response.completed");
			} else {
				expect(parsed.at(-1)?.event).toBe("response.failed");
				expect(
					parsed.some((event) => event.event === "response.output_item.done"),
				).toBe(false);
				expect(
					parsed.some((event) => event.event === "response.completed"),
				).toBe(false);
			}
		}
	});

	test("simple text streaming — correct event sequence and content", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: " world" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_001",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.headers.get("content-type")).toBe("text/event-stream");

		const parsed = await collectSseEvents(result);

		// First event: response.created
		expect(parsed[0].event).toBe("response.created");
		const created = parsed[0].data as Record<string, unknown>;
		expect(created.type).toBe("response.created");
		expect((created.response as Record<string, unknown>).status).toBe(
			"in_progress",
		);

		// Second event: response.in_progress
		expect(parsed[1].event).toBe("response.in_progress");

		// Third event: response.output_item.added (message item)
		expect(parsed[2].event).toBe("response.output_item.added");
		const added = parsed[2].data as Record<string, unknown>;
		expect((added.item as Record<string, unknown>).type).toBe("message");
		expect((added.item as Record<string, unknown>).role).toBe("assistant");

		// Fourth: response.content_part.added
		expect(parsed[3].event).toBe("response.content_part.added");

		// Fifth + sixth: response.output_text.delta
		expect(parsed[4].event).toBe("response.output_text.delta");
		const delta1 = parsed[4].data as Record<string, unknown>;
		expect(delta1.delta).toBe("Hello");

		expect(parsed[5].event).toBe("response.output_text.delta");
		const delta2 = parsed[5].data as Record<string, unknown>;
		expect(delta2.delta).toBe(" world");

		// Seventh: response.output_text.done with full accumulated text
		expect(parsed[6].event).toBe("response.output_text.done");
		const textDone = parsed[6].data as Record<string, unknown>;
		expect(textDone.type).toBe("response.output_text.done");
		expect(textDone.item_id).toBe("resp_001_msg_0");
		expect(textDone.output_index).toBe(0);
		expect(textDone.content_index).toBe(0);
		expect(textDone.text).toBe("Hello world");

		// Eighth: response.content_part.done
		expect(parsed[7].event).toBe("response.content_part.done");

		// Ninth: response.output_item.done with full text
		expect(parsed[8].event).toBe("response.output_item.done");
		const done = parsed[8].data as Record<string, unknown>;
		const doneItem = done.item as Record<string, unknown>;
		expect(doneItem.type).toBe("message");
		expect(doneItem.status).toBe("completed");
		const content = doneItem.content as Array<Record<string, unknown>>;
		expect(content[0].text).toBe("Hello world");

		// Last: response.completed with usage
		const lastEvent = parsed[parsed.length - 1];
		expect(lastEvent.event).toBe("response.completed");
		const doneFinal = lastEvent.data as Record<string, unknown>;
		const usage = (doneFinal.response as Record<string, unknown>)
			.usage as Record<string, number>;
		expect(usage.input_tokens).toBe(10);
		expect(usage.output_tokens).toBe(5);
		expect(usage.total_tokens).toBe(15);
	});

	test("tool call streaming — correct function_call item events", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_2", usage: { input_tokens: 20, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call_1", name: "read_file" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"path":' },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '"/tmp/x"}' },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 8 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_002",
			"claude-3-5-sonnet-20241022",
		);

		const parsed = await collectSseEvents(result);

		// output_item.added should be a function_call
		const addedEvent = parsed.find(
			(e) => e.event === "response.output_item.added",
		);
		expect(addedEvent).toBeDefined();
		const addedItem = (addedEvent?.data as Record<string, unknown>)
			.item as Record<string, unknown>;
		expect(addedItem.type).toBe("function_call");
		expect(addedItem.call_id).toBe("call_1");
		expect(addedItem.name).toBe("read_file");

		// function_call_arguments.delta events
		const argDeltas = parsed.filter(
			(e) => e.event === "response.function_call_arguments.delta",
		);
		expect(argDeltas.length).toBeGreaterThan(0);

		// output_item.done should have complete arguments
		const doneEvent = parsed.find(
			(e) => e.event === "response.output_item.done",
		);
		expect(doneEvent).toBeDefined();
		const doneItem = (doneEvent?.data as Record<string, unknown>)
			.item as Record<string, unknown>;
		expect(doneItem.type).toBe("function_call");
		expect(doneItem.status).toBe("completed");
		expect(doneItem.arguments).toBe('{"path":"/tmp/x"}');

		// response.completed at end
		const lastEvent = parsed[parsed.length - 1];
		expect(lastEvent.event).toBe("response.completed");
	});

	test("mixed text + tool — both message and function_call items emitted in order", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_3", usage: { input_tokens: 15, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Sure!" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "call_2", name: "search" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 1,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 12 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_003",
			"claude-3-5-sonnet-20241022",
		);

		const parsed = await collectSseEvents(result);

		const addedEvents = parsed.filter(
			(e) => e.event === "response.output_item.added",
		);
		expect(addedEvents).toHaveLength(2);
		expect(
			(
				(addedEvents[0].data as Record<string, unknown>).item as Record<
					string,
					unknown
				>
			).type,
		).toBe("message");
		expect(
			(
				(addedEvents[1].data as Record<string, unknown>).item as Record<
					string,
					unknown
				>
			).type,
		).toBe("function_call");

		const doneEvents = parsed.filter(
			(e) => e.event === "response.output_item.done",
		);
		expect(doneEvents).toHaveLength(2);

		// Last event is response.completed
		expect(parsed[parsed.length - 1].event).toBe("response.completed");
	});

	test("response.completed usage stats — input, output, total correct", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_4", usage: { input_tokens: 42, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 17 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_004",
			"test-model",
		);

		const parsed = await collectSseEvents(result);
		const doneEvent = parsed.find((e) => e.event === "response.completed");
		expect(doneEvent).toBeDefined();

		const resp = (doneEvent?.data as Record<string, unknown>)
			.response as Record<string, unknown>;
		const usage = resp.usage as Record<string, number>;
		expect(usage.input_tokens).toBe(42);
		expect(usage.output_tokens).toBe(17);
		expect(usage.total_tokens).toBe(59);
		expect(resp.id).toBe("resp_004");
		expect(resp.model).toBe("test-model");
		expect(resp.status).toBe("completed");
	});

	test("malformed upstream SSE diagnostics never log payload content", async () => {
		const payloadMarker = "PRIVATE_PROMPT_MARKER_MUST_NOT_BE_LOGGED";
		const logs: unknown[] = [];
		const listener = (event: unknown) => logs.push(event);
		logBus.on("log", listener);
		try {
			const upstream = new Response(
				`event: content_block_delta\ndata: {"secret":"${payloadMarker}"\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
			await translateAnthropicStreamToResponses(
				upstream,
				"resp_malformed",
				"gpt-5.6-sol",
			).text();
		} finally {
			logBus.off("log", listener);
		}
		expect(JSON.stringify(logs)).toContain(
			"Failed to parse upstream SSE event data",
		);
		expect(JSON.stringify(logs)).not.toContain(payloadMarker);
	});
	test("translates a CRLF-framed upstream stream", async () => {
		// An upstream that terminates SSE frames with \r\n\r\n contains no
		// literal "\n\n", so a literal split finds no boundary: every event
		// stays buffered until flush and only the last one survives.
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: {
					id: "msg_crlf",
					model: "claude-3-5-sonnet",
					usage: { input_tokens: 11, output_tokens: 0 },
				},
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hello" },
			}),
			sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 3 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		].map((e) => e.replace(/\n/g, "\r\n"));

		const body = `${events.join("\r\n\r\n")}\r\n\r\n`;
		const upstream = new Response(body, {
			headers: { "Content-Type": "text/event-stream" },
		});

		const translated = translateAnthropicStreamToResponses(upstream, "gpt-5");
		const got = await collectSseEvents(translated);
		const types = got.map((e) => e.event);

		expect(types).toContain("response.created");
		expect(types).toContain("response.output_text.delta");
		expect(types).toContain("response.completed");

		const delta = got.find((e) => e.event === "response.output_text.delta");
		expect((delta?.data as { delta?: string })?.delta).toBe("hello");
	});

	test("flushes a final frame with no trailing delimiter", async () => {
		// Every other fixture's body ends with "\n\n", so the last frame is
		// always drained by transform(). Omit it here so the last frame stays
		// in lineBuffer until flush() and exercises the flush-only code path.
		// End on message_delta (not message_stop): message_stop carries no
		// data of its own, so a broken flush would still pass by falling back
		// to emitDone()'s defaults. message_delta's output_tokens only reaches
		// the final usage if this trailing, undelimited frame is actually
		// parsed and processed rather than silently dropped.
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: {
					id: "msg_noeof",
					usage: { input_tokens: 5, output_tokens: 0 },
				},
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			}),
			sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 7 },
			}),
		];

		// No trailing "\n\n" after the last event.
		const body = events.join("\n\n");
		const upstream = new Response(body, {
			headers: { "Content-Type": "text/event-stream" },
		});

		const translated = translateAnthropicStreamToResponses(upstream, "gpt-5");
		const got = await collectSseEvents(translated);
		const types = got.map((e) => e.event);

		expect(types).toContain("response.created");
		expect(types).toContain("response.output_text.delta");
		expect(types).toContain("response.completed");

		const delta = got.find((e) => e.event === "response.output_text.delta");
		expect((delta?.data as { delta?: string })?.delta).toBe("hi");

		// Proves the trailing, undelimited message_delta frame was actually
		// parsed by flush() rather than dropped — output_tokens would be 0
		// (emitDone()'s default) if that frame never reached processEvent().
		const doneEvent = got.find((e) => e.event === "response.completed");
		const usage = (
			(doneEvent?.data as Record<string, unknown>).response as Record<
				string,
				unknown
			>
		).usage as Record<string, number>;
		expect(usage.output_tokens).toBe(7);
	});
});
