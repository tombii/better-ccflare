export const ANTHROPIC_MESSAGE_STOP_FRAME =
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

export const ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS = 10_000;

const encoder = new TextEncoder();
const messageStopBytes = encoder.encode(ANTHROPIC_MESSAGE_STOP_FRAME);

export type AnthropicTerminalRecoveryReason = "timeout" | "eof";

export interface AnthropicTerminalRecoveryOptions {
	/** @internal Override only in deterministic unit tests. */
	gracePeriodMs?: number;
	onRecovery?: (reason: AnthropicTerminalRecoveryReason) => void;
	onCancelError?: (
		error: unknown,
		reason: AnthropicTerminalRecoveryReason,
	) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Observe a native Anthropic SSE stream without rewriting its upstream bytes.
 *
 * A terminal `message_delta` carries the authoritative stop reason. Anthropic's
 * protocol follows it with `message_stop`; if that final event never arrives,
 * Claude Code waits for semantic progress until its watchdog expires. This
 * wrapper gives the upstream a short grace period, then supplies only the
 * protocol terminator that was already implied by the terminal delta.
 */
export function createAnthropicTerminalRecoveryStream(
	upstream: ReadableStream<Uint8Array>,
	options: AnthropicTerminalRecoveryOptions = {},
): ReadableStream<Uint8Array> {
	const gracePeriodMs =
		options.gracePeriodMs ?? ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS;
	const reader = upstream.getReader();
	const decoder = new TextDecoder();

	let eventBuffer = "";
	let terminalDeltaSeen = false;
	let messageStopSeen = false;
	let finalized = false;
	let upstreamCancelPromise: Promise<void> | null = null;
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let downstreamController:
		| ReadableStreamDefaultController<Uint8Array>
		| undefined;

	const clearRecoveryTimer = (): void => {
		if (recoveryTimer === null) return;
		clearTimeout(recoveryTimer);
		recoveryTimer = null;
	};

	const cancelUpstream = (reason: unknown): Promise<void> => {
		if (upstreamCancelPromise) return upstreamCancelPromise;
		try {
			upstreamCancelPromise = reader.cancel(reason);
		} catch (error) {
			upstreamCancelPromise = Promise.reject(error);
		}
		return upstreamCancelPromise;
	};

	const reportRecovery = (reason: AnthropicTerminalRecoveryReason): void => {
		try {
			options.onRecovery?.(reason);
		} catch {
			// Observability must never interfere with client stream recovery.
		}
	};

	const reportCancelError = (
		error: unknown,
		reason: AnthropicTerminalRecoveryReason,
	): void => {
		try {
			options.onCancelError?.(error, reason);
		} catch {
			// Observability must never interfere with an already-complete stream.
		}
	};

	const appendMissingEventDelimiter = (delimiter: string): void => {
		if (delimiter && downstreamController) {
			downstreamController.enqueue(encoder.encode(delimiter));
		}
	};

	const cancelAfterForcedClose = (
		reason: AnthropicTerminalRecoveryReason,
		message: string,
	): void => {
		void cancelUpstream(new Error(message)).catch((error: unknown) => {
			reportCancelError(error, reason);
		});
	};

	const recover = (
		reason: AnthropicTerminalRecoveryReason,
		missingEventDelimiter = "",
	): void => {
		if (finalized || messageStopSeen || !downstreamController) return;

		finalized = true;
		clearRecoveryTimer();
		appendMissingEventDelimiter(missingEventDelimiter);
		downstreamController.enqueue(messageStopBytes.slice());
		downstreamController.close();
		reportRecovery(reason);
		cancelAfterForcedClose(
			reason,
			`Anthropic stream recovered after missing message_stop (${reason})`,
		);
	};

	const inspectEvent = (rawEvent: string): void => {
		let eventType: string | undefined;
		const dataLines: string[] = [];

		for (const line of rawEvent.split(/\r?\n/)) {
			if (line.length === 0 || line.startsWith(":")) continue;

			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);

			if (field === "event") eventType = value;
			if (field === "data") dataLines.push(value);
		}

		if (dataLines.length === 0) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(dataLines.join("\n")) as unknown;
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;

		const isMessageStop =
			eventType === "message_stop" || parsed.type === "message_stop";
		if (isMessageStop) {
			messageStopSeen = true;
			clearRecoveryTimer();
			return;
		}

		const isMessageDelta =
			eventType === "message_delta" || parsed.type === "message_delta";
		const stopReason = isRecord(parsed.delta)
			? parsed.delta.stop_reason
			: undefined;
		if (isMessageDelta && stopReason !== null && stopReason !== undefined) {
			terminalDeltaSeen = true;
			armRecoveryTimer();
		}
	};

	const takeBufferedEventDelimiter = (): string => {
		if (eventBuffer.length === 0) return "";
		const bufferedEvent = eventBuffer;
		eventBuffer = "";
		inspectEvent(bufferedEvent);
		return bufferedEvent.endsWith("\r\n")
			? "\r\n"
			: bufferedEvent.endsWith("\n")
				? "\n"
				: "\n\n";
	};

	const finalizeBufferedMessageStopAtTimeout = (
		missingEventDelimiter: string,
	): void => {
		if (finalized || !downstreamController) return;
		finalized = true;
		clearRecoveryTimer();
		appendMissingEventDelimiter(missingEventDelimiter);
		downstreamController.close();
		cancelAfterForcedClose(
			"timeout",
			"Anthropic stream closed after message_stop at timeout boundary",
		);
	};

	const handleRecoveryTimeout = (): void => {
		recoveryTimer = null;
		if (finalized) return;
		const missingEventDelimiter = takeBufferedEventDelimiter();
		if (messageStopSeen) {
			finalizeBufferedMessageStopAtTimeout(missingEventDelimiter);
			return;
		}
		recover("timeout", missingEventDelimiter);
	};

	const armRecoveryTimer = (): void => {
		if (recoveryTimer !== null || finalized || messageStopSeen) return;
		recoveryTimer = setTimeout(handleRecoveryTimeout, gracePeriodMs);
	};

	const inspectChunk = (chunk: Uint8Array): void => {
		eventBuffer += decoder.decode(chunk, { stream: true });

		let delimiter = /\r?\n\r?\n/.exec(eventBuffer);
		while (delimiter?.index !== undefined) {
			const rawEvent = eventBuffer.slice(0, delimiter.index);
			eventBuffer = eventBuffer.slice(delimiter.index + delimiter[0].length);
			inspectEvent(rawEvent);
			delimiter = /\r?\n\r?\n/.exec(eventBuffer);
		}
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			downstreamController = controller;
		},

		async pull(controller) {
			if (finalized) return;

			try {
				const { value, done } = await reader.read();
				if (finalized) return;

				if (done) {
					eventBuffer += decoder.decode();
					const missingEventDelimiter = takeBufferedEventDelimiter();
					if (terminalDeltaSeen && !messageStopSeen) {
						recover("eof", missingEventDelimiter);
						return;
					}

					finalized = true;
					clearRecoveryTimer();
					if (messageStopSeen) {
						appendMissingEventDelimiter(missingEventDelimiter);
					}
					controller.close();
					return;
				}

				controller.enqueue(value);
				inspectChunk(value);
			} catch (error) {
				if (finalized) return;
				finalized = true;
				clearRecoveryTimer();
				controller.error(error);
			}
		},

		cancel(reason) {
			if (finalized) return;
			finalized = true;
			clearRecoveryTimer();
			return cancelUpstream(reason);
		},
	});
}
