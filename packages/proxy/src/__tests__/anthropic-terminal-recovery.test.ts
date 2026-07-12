import { describe, expect, it, mock } from "bun:test";
import {
	ANTHROPIC_MESSAGE_STOP_FRAME,
	createAnthropicTerminalRecoveryStream,
} from "../anthropic-terminal-recovery";
import { teeStream } from "../stream-tee";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

function immediateStream(
	chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function controllableStream(
	onCancel: (reason?: unknown) => void | Promise<void> = () => undefined,
) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = mock(onCancel);
	const stream = new ReadableStream<Uint8Array>({
		start(nextController) {
			controller = nextController;
		},
		cancel,
	});

	return { stream, controller: () => controller, cancel };
}

const terminalDelta =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}\n\n';
const messageStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
const contentBlockStart =
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
const contentBlockStop =
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
const contentBlockDelta =
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n';
const overloadedError =
	'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';

describe("createAnthropicTerminalRecoveryStream", () => {
	it("leaves a healthy stream byte-for-byte unchanged", async () => {
		const original = `${terminalDelta}${messageStop}`;
		const chunks = [
			bytes(original.slice(0, 7)),
			bytes(original.slice(7, 63)),
			bytes(original.slice(63)),
		];
		const onRecovery = mock(() => undefined);

		const body = createAnthropicTerminalRecoveryStream(
			immediateStream(chunks),
			{ gracePeriodMs: 10, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("parses arbitrary chunk splits and recovers a terminal delta missing message_stop", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		for (const byte of bytes(terminalDelta)) {
			source.controller().enqueue(new Uint8Array([byte]));
		}
		source.controller().enqueue(bytes(ping));

		await expect(result).resolves.toBe(
			`${terminalDelta}${ping}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("does not let ping events defer recovery", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 25,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		const interval = setInterval(() => {
			try {
				source.controller().enqueue(bytes(ping));
			} catch {
				clearInterval(interval);
			}
		}, 3);

		try {
			const output = await result;
			expect(output.startsWith(terminalDelta)).toBe(true);
			expect(output.endsWith(ANTHROPIC_MESSAGE_STOP_FRAME)).toBe(true);
			expect(onRecovery).toHaveBeenCalledTimes(1);
		} finally {
			clearInterval(interval);
		}
	});

	it("does not let recovery overtake unread upstream events during downstream backpressure", async () => {
		const source = controllableStream();
		const realMessageStop =
			'event: message_stop\ndata: {"type":"message_stop","marker":"real-upstream-stop"}\n\n';
		const original = `${terminalDelta}${ping}${ping}${realMessageStop}`;
		const recoveryBody = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 25,
		});
		const clientBody = teeStream(recoveryBody);
		const reader = clientBody.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(ping));
		source.controller().enqueue(bytes(ping));
		source.controller().enqueue(bytes(realMessageStop));
		source.controller().close();

		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(new TextDecoder().decode(first.value)).toBe(terminalDelta);
		await new Promise((resolve) => setTimeout(resolve, 70));

		let output = new TextDecoder().decode(first.value);
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			output += new TextDecoder().decode(next.value);
		}

		expect(output).toBe(original);
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("separates a partial post-terminal ping before timeout recovery", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const partialPing = ping.slice(0, -2);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(partialPing));

		await expect(result).resolves.toBe(
			`${terminalDelta}${partialPing}\n\n${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("does not duplicate a real message_stop buffered at the timeout boundary", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const partialMessageStop = messageStop.slice(0, -2);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(partialMessageStop));

		await expect(result).resolves.toBe(
			`${terminalDelta}${partialMessageStop}\n\n`,
		);
		expect(onRecovery).not.toHaveBeenCalled();
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("closes a message_stop data line that only lacks its final blank line", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const messageStopWithoutBlankLine = messageStop.slice(0, -1);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(messageStopWithoutBlankLine));

		await expect(result).resolves.toBe(`${terminalDelta}${messageStop}`);
		expect(onRecovery).not.toHaveBeenCalled();
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("preserves a message_stop that completes shortly before the timeout", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 50,
			onRecovery,
		});
		const result = new Response(body).text();
		const split = messageStop.length - 2;

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(messageStop.slice(0, split)));
		await new Promise((resolve) => setTimeout(resolve, 20));
		source.controller().enqueue(bytes(messageStop.slice(split)));
		source.controller().close();

		await expect(result).resolves.toBe(`${terminalDelta}${messageStop}`);
		expect(onRecovery).not.toHaveBeenCalled();
		expect(source.cancel).not.toHaveBeenCalled();
	});

	it("never synthesizes for message_delta without a stop reason", async () => {
		const original =
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null}}\n\n' +
			ping;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("passes valid JSON null and scalar data through unchanged", async () => {
		const original =
			"event: ping\ndata: null\n\n" +
			'event: message_delta\ndata: "scalar"\n\n' +
			"data: 42\n\n";
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("synthesizes exactly once on clean EOF after a terminal delta", async () => {
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(terminalDelta)]),
			{ gracePeriodMs: 50, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
	});

	it("recovers a terminal delta buffered at EOF without a blank-line delimiter", async () => {
		const terminalDeltaWithoutDelimiter = terminalDelta.slice(0, -2);
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(terminalDeltaWithoutDelimiter)]),
			{ gracePeriodMs: 50, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(
			`${terminalDeltaWithoutDelimiter}\n\n${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
	});

	it("starts recovery for a complete terminal data line without a blank-line delimiter", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const terminalDeltaWithoutBlankLine = terminalDelta.slice(0, -1);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDeltaWithoutBlankLine));
		const settled = await Promise.race([
			result,
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
		]);
		if (settled === false) source.controller().close();

		expect(settled).toBe(
			`${terminalDeltaWithoutBlankLine}\n${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
	});

	it("never synthesizes success after an in-band error event", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(overloadedError));
		await new Promise((resolve) => setTimeout(resolve, 40));
		try {
			source.controller().close();
		} catch {
			// The pre-fix implementation already closed after false recovery.
		}

		await expect(result).resolves.toBe(`${terminalDelta}${overloadedError}`);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("treats the SSE error field as failure even when data is not JSON", async () => {
		const source = controllableStream();
		const plainTextError = "event: error\ndata: upstream disconnected\n\n";
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(plainTextError));
		await new Promise((resolve) => setTimeout(resolve, 40));
		source.controller().close();

		await expect(result).resolves.toBe(`${terminalDelta}${plainTextError}`);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("treats a payload error type as failure without an SSE error field", async () => {
		const payloadOnlyError =
			'data: {"type":"error","error":{"type":"api_error","message":"failed"}}\n\n';
		const original = `${terminalDelta}${payloadOnlyError}`;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("fails closed on unparseable data events but still permits explicit ping keepalives", async () => {
		const malformedEvent =
			'event: content_block_start\ndata: {"type":"content_block_start"\n\n';
		for (const original of [
			`${malformedEvent}${terminalDelta}`,
			`${terminalDelta}${malformedEvent}`,
		]) {
			const onRecovery = mock(() => undefined);
			const body = createAnthropicTerminalRecoveryStream(
				immediateStream([bytes(original)]),
				{ gracePeriodMs: 5, onRecovery },
			);

			await expect(new Response(body).text()).resolves.toBe(original);
			expect(onRecovery).not.toHaveBeenCalled();
		}

		const malformedPing = "event: ping\ndata: not-json\n\n";
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 5,
			onRecovery,
		});
		const result = new Response(body).text();
		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(malformedPing));

		await expect(result).resolves.toBe(
			`${terminalDelta}${malformedPing}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
	});

	it("does not synthesize while a content block remains open", async () => {
		const original = `${contentBlockStart}${terminalDelta}`;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("does not re-enable recovery when an open block closes after the terminal delta", async () => {
		const original = `${contentBlockStart}${terminalDelta}${contentBlockStop}`;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("disables recovery after malformed content-block transitions", async () => {
		const indexlessStart =
			'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n';
		const indexlessStop =
			'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n';
		const cases = [
			`${indexlessStart}${indexlessStart}${indexlessStop}${terminalDelta}`,
			`${contentBlockStart}${contentBlockStart}${contentBlockStop}${terminalDelta}`,
			`${contentBlockStop}${terminalDelta}`,
		];

		for (const original of cases) {
			const onRecovery = mock(() => undefined);
			const body = createAnthropicTerminalRecoveryStream(
				immediateStream([bytes(original)]),
				{ gracePeriodMs: 5, onRecovery },
			);

			await expect(new Response(body).text()).resolves.toBe(original);
			expect(onRecovery).not.toHaveBeenCalled();
		}
	});

	it("validates every content-block delta against the open block lifecycle", async () => {
		const invalidDelta =
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":-1,"delta":{"type":"text_delta","text":"bad"}}\n\n';
		const invalidCases = [
			`${contentBlockDelta}${terminalDelta}`,
			`${contentBlockStart}${contentBlockStop}${contentBlockDelta}${terminalDelta}`,
			`${terminalDelta}${contentBlockDelta}`,
			`${invalidDelta}${terminalDelta}`,
		];

		for (const original of invalidCases) {
			const onRecovery = mock(() => undefined);
			const body = createAnthropicTerminalRecoveryStream(
				immediateStream([bytes(original)]),
				{ gracePeriodMs: 5, onRecovery },
			);

			await expect(new Response(body).text()).resolves.toBe(original);
			expect(onRecovery).not.toHaveBeenCalled();
		}

		const valid = `${contentBlockStart}${contentBlockDelta}${contentBlockStop}${terminalDelta}`;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(valid)]),
			{ gracePeriodMs: 5, onRecovery },
		);
		await expect(new Response(body).text()).resolves.toBe(
			`${valid}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		expect(onRecovery).toHaveBeenCalledTimes(1);
	});

	it("passes through an oversized event but disables later recovery", async () => {
		const oversizedEvent = `data: ${"x".repeat(80 * 1024)}\n\n`;
		const original = `${oversizedEvent}${contentBlockStart}${contentBlockStop}${terminalDelta}`;
		const chunks: Uint8Array[] = [];
		for (let offset = 0; offset < original.length; offset += 1024) {
			chunks.push(bytes(original.slice(offset, offset + 1024)));
		}
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream(chunks),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("does not append a delimiter to trailing data after a complete message_stop", async () => {
		const trailingData = `data: ${"x".repeat(80 * 1024)}\n`;
		const original = `${terminalDelta}${messageStop}${trailingData}`;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(
			immediateStream([bytes(original)]),
			{ gracePeriodMs: 5, onRecovery },
		);

		await expect(new Response(body).text()).resolves.toBe(original);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("disables recovery if an oversized event becomes uninspectable after the terminal delta", async () => {
		const source = controllableStream();
		const oversizedPendingEvent = `data: ${"x".repeat(80 * 1024)}\n`;
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		source.controller().enqueue(bytes(oversizedPendingEvent));
		await new Promise((resolve) => setTimeout(resolve, 40));
		try {
			source.controller().close();
		} catch {
			// The pre-fix implementation already closed after unsafe recovery.
		}

		await expect(result).resolves.toBe(
			`${terminalDelta}${oversizedPendingEvent}`,
		);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("handles oversized events consistently across transport chunking", async () => {
		const largeDelta = `event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "x".repeat(80 * 1024) },
		})}\n\n`;
		const original = `${contentBlockStart}${largeDelta}${contentBlockStop}${terminalDelta}`;
		const splitChunks: Uint8Array[] = [];
		for (let offset = 0; offset < original.length; offset += 1024) {
			splitChunks.push(bytes(original.slice(offset, offset + 1024)));
		}

		for (const chunks of [[bytes(original)], splitChunks]) {
			const onRecovery = mock(() => undefined);
			const body = createAnthropicTerminalRecoveryStream(
				immediateStream(chunks),
				{ gracePeriodMs: 5, onRecovery },
			);

			await expect(new Response(body).text()).resolves.toBe(original);
			expect(onRecovery).not.toHaveBeenCalled();
		}
	});

	it("propagates upstream errors without masking them as successful completion", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onRecovery,
		});
		const reader = body.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(reader.read()).resolves.toMatchObject({ done: false });
		source.controller().error(new Error("upstream failed"));
		await expect(reader.read()).rejects.toThrow("upstream failed");
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("cancels upstream once and disarms recovery when downstream cancels", async () => {
		const source = controllableStream();
		const onRecovery = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 10,
			onRecovery,
		});
		const reader = body.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(reader.read()).resolves.toMatchObject({ done: false });
		await reader.cancel("client disconnected");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(source.cancel).toHaveBeenCalledTimes(1);
		expect(onRecovery).not.toHaveBeenCalled();
	});

	it("propagates an upstream cancellation failure to downstream cancel", async () => {
		const cancelError = new Error("upstream cancel failed");
		const source = controllableStream(() => Promise.reject(cancelError));
		const onCancelError = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onCancelError,
		});
		const reader = body.getReader();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(reader.read()).resolves.toMatchObject({ done: false });
		await expect(reader.cancel("client disconnected")).rejects.toThrow(
			"upstream cancel failed",
		);

		expect(source.cancel).toHaveBeenCalledTimes(1);
		expect(onCancelError).not.toHaveBeenCalled();
	});

	it("reports a recovery cancellation failure after completing downstream", async () => {
		const cancelError = new Error("recovery cancel failed");
		const source = controllableStream(() => Promise.reject(cancelError));
		const onCancelError = mock(() => undefined);
		const body = createAnthropicTerminalRecoveryStream(source.stream, {
			gracePeriodMs: 20,
			onCancelError,
		});
		const result = new Response(body).text();

		source.controller().enqueue(bytes(terminalDelta));
		await expect(result).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onCancelError).toHaveBeenCalledTimes(1);
		expect(onCancelError).toHaveBeenCalledWith(cancelError, "timeout");
	});
});
