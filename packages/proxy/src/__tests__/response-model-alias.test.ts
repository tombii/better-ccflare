import { describe, expect, it, spyOn } from "bun:test";
import {
	MAX_ANTHROPIC_MESSAGE_JSON_ALIAS_BYTES,
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

	it("rewrites a JSON response exactly at the buffering limit", async () => {
		const prefix = '{"type":"message","model":"backend","content":"';
		const suffix = '"}';
		const padding = "x".repeat(
			MAX_ANTHROPIC_MESSAGE_JSON_ALIAS_BYTES -
				encoder.encode(prefix + suffix).length,
		);
		const body = prefix + padding + suffix;
		expect(encoder.encode(body).length).toBe(
			MAX_ANTHROPIC_MESSAGE_JSON_ALIAS_BYTES,
		);
		const upstream = new Response(encoder.encode(body)).body;
		expect(upstream).not.toBeNull();

		const output = await collect(
			rewriteAnthropicMessageJsonModelStream(
				upstream as ReadableStream<Uint8Array>,
				"client-alias",
			),
		);
		expect(JSON.parse(output).model).toBe("client-alias");
	});

	it("owns buffered Node Buffer subarrays before the source mutates", async () => {
		const source = Buffer.from(
			JSON.stringify({ type: "message", model: "backend", content: "stable" }),
		);
		let closeUpstream: (() => void) | undefined;
		let firstPull = true;
		const waitingToClose = new Promise<void>((resolve) => {
			closeUpstream = resolve;
		});
		let chunkBuffered: (() => void) | undefined;
		const buffered = new Promise<void>((resolve) => {
			chunkBuffered = resolve;
		});
		const upstream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (firstPull) {
					firstPull = false;
					controller.enqueue(source.subarray(0));
					return;
				}
				chunkBuffered?.();
				await waitingToClose;
				controller.close();
			},
		});
		const output = collect(
			rewriteAnthropicMessageJsonModelStream(upstream, "client-alias"),
		);

		await buffered;
		source.fill(120);
		closeUpstream?.();
		expect(JSON.parse(await output)).toEqual({
			type: "message",
			model: "client-alias",
			content: "stable",
		});
	});

	it("passes one oversized JSON chunk through byte-for-byte without parsing", async () => {
		const parseSpy = spyOn(JSON, "parse");
		const body = encoder.encode(
			JSON.stringify({
				type: "message",
				model: "backend",
				content: "x".repeat(MAX_ANTHROPIC_MESSAGE_JSON_ALIAS_BYTES),
			}),
		);
		const parseCallsBefore = parseSpy.mock.calls.length;
		const upstream = new Response(body).body;
		expect(upstream).not.toBeNull();

		const output = new Uint8Array(
			await new Response(
				rewriteAnthropicMessageJsonModelStream(
					upstream as ReadableStream<Uint8Array>,
					"client-alias",
				),
			).arrayBuffer(),
		);
		expect(output).toEqual(body);
		expect(parseSpy.mock.calls.length).toBe(parseCallsBefore);
		parseSpy.mockRestore();
	});

	it("falls back after many small chunks and preserves UTF-8 bytes", async () => {
		const parseSpy = spyOn(JSON, "parse");
		const fragment = encoder.encode("héllo 🌍 ".repeat(64));
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (size <= MAX_ANTHROPIC_MESSAGE_JSON_ALIAS_BYTES) {
			const backing = new Uint8Array(fragment.length + 128);
			backing.set(fragment, 64);
			const chunk = backing.subarray(64, 64 + fragment.length);
			chunks.push(chunk);
			size += chunk.length;
		}
		const expected = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			expected.set(chunk, offset);
			offset += chunk.length;
		}
		const parseCallsBefore = parseSpy.mock.calls.length;
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = new Uint8Array(
			await new Response(
				rewriteAnthropicMessageJsonModelStream(upstream, "client-alias"),
			).arrayBuffer(),
		);
		expect(output).toEqual(expected);
		expect(new TextDecoder().decode(output)).toBe(
			new TextDecoder().decode(expected),
		);
		expect(parseSpy.mock.calls.length).toBe(parseCallsBefore);
		parseSpy.mockRestore();
	});

	it("forwards upstream errors after switching to pass-through", async () => {
		const upstreamError = new Error("upstream failed");
		let reads = 0;
		const upstream = new ReadableStream<Uint8Array>({
			pull(controller) {
				reads++;
				if (reads === 1) {
					controller.enqueue(
						new Uint8Array(MAX_ANTHROPIC_MESSAGE_JSON_ALIAS_BYTES + 1),
					);
					return;
				}
				controller.error(upstreamError);
			},
		});
		const reader = rewriteAnthropicMessageJsonModelStream(
			upstream,
			"client-alias",
		).getReader();

		expect((await reader.read()).done).toBe(false);
		await expect(reader.read()).rejects.toBe(upstreamError);
	});

	it("forwards cancellation while pass-through is pending after fallback", async () => {
		let cancelReason: unknown;
		let reads = 0;
		const oversized = new Uint8Array(
			MAX_ANTHROPIC_MESSAGE_JSON_ALIAS_BYTES + 1,
		).fill(120);
		const upstream = new ReadableStream<Uint8Array>({
			pull(controller) {
				reads++;
				if (reads === 1) {
					controller.enqueue(oversized);
					return;
				}
				return new Promise<void>(() => {});
			},
			cancel(reason) {
				cancelReason = reason;
			},
		});
		const reader = rewriteAnthropicMessageJsonModelStream(
			upstream,
			"client-alias",
		).getReader();

		const first = await reader.read();
		expect(first.value).toEqual(oversized);
		const pendingRead = reader.read().catch(() => undefined);
		await Promise.resolve();
		await reader.cancel("client left after fallback");
		await pendingRead;
		expect(cancelReason).toBe("client left after fallback");
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
