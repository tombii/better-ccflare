import { describe, expect, it, mock } from "bun:test";
import {
	ANTHROPIC_MESSAGE_STOP_FRAME,
	createAnthropicTerminalRecoveryStream,
} from "../anthropic-terminal-recovery";

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
