import { describe, expect, it, spyOn } from "bun:test";
import {
	rewriteAnthropicMessageJsonModel,
	rewriteAnthropicMessageJsonModelStream,
	rewriteAnthropicMessageSseModel,
} from "../response-model-alias";

const encoder = new TextEncoder();

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

describe("Anthropic response model aliasing", () => {
	it("rewrites only the top-level model in a non-streaming Message", () => {
		const body = JSON.stringify({
			id: "msg_backend",
			type: "message",
			role: "assistant",
			model: "gpt-5.3-codex",
			content: [
				{ type: "text", text: "the model string gpt-5.3-codex stays here" },
				{ type: "tool_use", id: "toolu_gpt-5.3-codex", name: "run", input: {} },
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 10, output_tokens: 5 },
		});

		const rewritten = rewriteAnthropicMessageJsonModel(body, "claude-opus-4-6");
		const parsed = JSON.parse(rewritten);
		expect(parsed.model).toBe("claude-opus-4-6");
		expect(parsed.id).toBe("msg_backend");
		expect(parsed.content[0].text).toBe(
			"the model string gpt-5.3-codex stays here",
		);
		expect(parsed.content[1].id).toBe("toolu_gpt-5.3-codex");
	});

	it("leaves errors and malformed JSON byte-for-byte unchanged", () => {
		const error = '{"type":"error","error":{"message":"model gpt-5"}}';
		expect(rewriteAnthropicMessageJsonModel(error, "client-alias")).toBe(error);
		expect(rewriteAnthropicMessageJsonModel("{broken", "client-alias")).toBe(
			"{broken",
		);
	});

	it("rewrites only message_start across arbitrary chunk boundaries", async () => {
		const source = [
			": upstream heartbeat\n\n",
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_gpt","type":"message","role":"assistant","model":"gpt-5.3-codex","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_gpt-5.3-codex","name":"run","input":{}}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"model\\":\\"gpt-5.3-codex\\"}"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("");
		const chunks = [
			source.slice(0, 17),
			source.slice(17, 93),
			source.slice(93),
		];
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});

		const output = await collect(
			rewriteAnthropicMessageSseModel(upstream, "claude-opus-4-6"),
		);
		expect(output).toContain('"model":"claude-opus-4-6"');
		expect(output).toContain('"id":"toolu_gpt-5.3-codex"');
		expect(output).toContain(
			'"partial_json":"{\\"model\\":\\"gpt-5.3-codex\\"}"',
		);
		expect(output).toStartWith(": upstream heartbeat\n\n");
	});

	it("preserves multibyte UTF-8 split after message_start byte-for-byte", async () => {
		const messageStart = encoder.encode(
			'event: message_start\ndata: {"type":"message_start","message":{"type":"message","model":"backend"}}\n\n',
		);
		const following = encoder.encode(
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"héllo 🌍"}}\n\n',
		);
		const emoji = encoder.encode("🌍");
		const emojiStart = following.indexOf(emoji[0]);
		expect(emojiStart).toBeGreaterThan(0);
		const splitAt = emojiStart + 1;
		const first = new Uint8Array(messageStart.length + splitAt);
		first.set(messageStart);
		first.set(following.slice(0, splitAt), messageStart.length);
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(first);
				controller.enqueue(following.slice(splitAt, following.length - 2));
				controller.enqueue(following.slice(following.length - 2));
				controller.close();
			},
		});

		const output = new Uint8Array(
			await new Response(
				rewriteAnthropicMessageSseModel(upstream, "client-alias"),
			).arrayBuffer(),
		);
		const rewrittenStart = encoder.encode(
			'event: message_start\ndata: {"type":"message_start","message":{"type":"message","model":"client-alias"}}\n\n',
		);
		expect(output.slice(0, rewrittenStart.length)).toEqual(rewrittenStart);
		expect(output.slice(rewrittenStart.length)).toEqual(following);
	});

	it("forwards cancellation without transforming after a pending JSON read", async () => {
		const parseSpy = spyOn(JSON, "parse");
		let cancelReason: unknown;
		let resolveRead: (() => void) | undefined;
		const cancelled = new Promise<void>((resolve) => {
			resolveRead = resolve;
		});
		const upstream = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise<void>(() => {});
			},
			cancel(reason) {
				cancelReason = reason;
				resolveRead?.();
			},
		});
		const downstream = rewriteAnthropicMessageJsonModelStream(
			upstream,
			"client-alias",
		);
		const reader = downstream.getReader();
		const pendingRead = reader.read().catch(() => undefined);
		const parseCallsBeforeCancel = parseSpy.mock.calls.length;
		await reader.cancel("client left");
		await cancelled;
		expect(cancelReason).toBe("client left");
		await pendingRead;
		await Promise.resolve();
		expect(parseSpy.mock.calls.length).toBe(parseCallsBeforeCancel);
		parseSpy.mockRestore();
	});

	it("preserves CRLF framing and passes non-message_start frames unchanged", async () => {
		const untouched =
			'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"gpt-5.3-codex"}}\r\n\r\n';
		const upstream = new Response(encoder.encode(untouched)).body;
		expect(upstream).not.toBeNull();
		expect(
			await collect(
				rewriteAnthropicMessageSseModel(
					upstream as ReadableStream<Uint8Array>,
					"client-alias",
				),
			),
		).toBe(untouched);
	});
});
