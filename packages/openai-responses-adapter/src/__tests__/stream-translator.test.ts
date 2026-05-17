import { describe, expect, test } from "bun:test";
import { translateAnthropicStreamToResponses } from "../stream-translator";

async function collectSseEvents(
	response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
	const text = await response.text();
	const events: Array<{ event: string; data: unknown }> = [];
	const rawEvents = text.split("\n\n").filter((s) => s.trim().length > 0);

	for (const rawEvent of rawEvents) {
		const lines = rawEvent.split("\n");
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

		// Second event: response.output_item.added (message item)
		expect(parsed[1].event).toBe("response.output_item.added");
		const added = parsed[1].data as Record<string, unknown>;
		expect((added.item as Record<string, unknown>).type).toBe("message");
		expect((added.item as Record<string, unknown>).role).toBe("assistant");

		// Third + fourth: response.output_text.delta
		expect(parsed[2].event).toBe("response.output_text.delta");
		const delta1 = parsed[2].data as Record<string, unknown>;
		expect((delta1.delta as Record<string, unknown>).text).toBe("Hello");

		expect(parsed[3].event).toBe("response.output_text.delta");
		const delta2 = parsed[3].data as Record<string, unknown>;
		expect((delta2.delta as Record<string, unknown>).text).toBe(" world");

		// Fifth: response.output_item.done with full text
		expect(parsed[4].event).toBe("response.output_item.done");
		const done = parsed[4].data as Record<string, unknown>;
		const doneItem = done.item as Record<string, unknown>;
		expect(doneItem.type).toBe("message");
		expect(doneItem.status).toBe("completed");
		const content = doneItem.content as Array<Record<string, unknown>>;
		expect(content[0].text).toBe("Hello world");

		// Last: response.done with usage
		const lastEvent = parsed[parsed.length - 1];
		expect(lastEvent.event).toBe("response.done");
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

		// response.done at end
		const lastEvent = parsed[parsed.length - 1];
		expect(lastEvent.event).toBe("response.done");
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

		// Last event is response.done
		expect(parsed[parsed.length - 1].event).toBe("response.done");
	});

	test("response.done usage stats — input, output, total correct", async () => {
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
		const doneEvent = parsed.find((e) => e.event === "response.done");
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
});
