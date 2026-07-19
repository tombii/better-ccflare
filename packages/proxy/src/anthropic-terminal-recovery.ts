export const ANTHROPIC_MESSAGE_STOP_FRAME =
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

export const ANTHROPIC_TERMINAL_RECOVERY_GRACE_MS = 10_000;

const encoder = new TextEncoder();
const messageStopBytes = encoder.encode(ANTHROPIC_MESSAGE_STOP_FRAME);
const MAX_PENDING_EVENT_CHARS = 64 * 1024;

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
	let eventBufferTruncated = false;
	let terminalDeltaSeen = false;
	let provisionalTerminalDeltaSeen = false;
	let messageStopSeen = false;
	let terminalFailureSeen = false;
	let recoveryDisabled = false;
	let unknownContentBlockOpen = false;
	const openContentBlocks = new Set<number>();
	let finalized = false;
	let upstreamCancelPromise: Promise<void> | null = null;
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let recoveryWaitRemainingMs = gracePeriodMs;
	let recoveryWaitStartedAt: number | null = null;
	let upstreamReadPending = false;
	let downstreamController:
		| ReadableStreamDefaultController<Uint8Array>
		| undefined;

	const clearRecoveryTimer = (): void => {
		if (recoveryTimer !== null) clearTimeout(recoveryTimer);
		recoveryTimer = null;
		recoveryWaitStartedAt = null;
	};

	const pauseRecoveryTimer = (): void => {
		if (recoveryTimer !== null) clearTimeout(recoveryTimer);
		recoveryTimer = null;
		if (recoveryWaitStartedAt === null) return;
		recoveryWaitRemainingMs = Math.max(
			0,
			recoveryWaitRemainingMs - (Date.now() - recoveryWaitStartedAt),
		);
		recoveryWaitStartedAt = null;
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
		if (
			finalized ||
			messageStopSeen ||
			terminalFailureSeen ||
			recoveryDisabled ||
			!terminalDeltaSeen ||
			unknownContentBlockOpen ||
			openContentBlocks.size > 0 ||
			!downstreamController
		)
			return;

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

	const markTerminalFailure = (): void => {
		terminalFailureSeen = true;
		terminalDeltaSeen = false;
		provisionalTerminalDeltaSeen = false;
		clearRecoveryTimer();
	};

	const disableRecovery = (): void => {
		recoveryDisabled = true;
		clearRecoveryTimer();
	};

	const inspectEvent = (rawEvent: string, provisional = false): void => {
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

		if (eventType === "error") {
			markTerminalFailure();
			return;
		}

		if (dataLines.length === 0) {
			if (!provisional && eventType !== undefined && eventType !== "ping") {
				disableRecovery();
			}
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(dataLines.join("\n")) as unknown;
		} catch {
			if (!provisional && eventType !== "ping") disableRecovery();
			return;
		}
		if (!isRecord(parsed)) {
			if (!provisional && eventType !== "ping") disableRecovery();
			return;
		}

		if (parsed.type === "error") {
			markTerminalFailure();
			return;
		}
		if (eventType === "ping") return;

		const isMessageStop =
			eventType === "message_stop" || parsed.type === "message_stop";
		if (isMessageStop) {
			if (provisional) return;
			messageStopSeen = true;
			provisionalTerminalDeltaSeen = false;
			clearRecoveryTimer();
			return;
		}

		if (!provisional) {
			const contentBlockIndex =
				typeof parsed.index === "number" &&
				Number.isSafeInteger(parsed.index) &&
				parsed.index >= 0
					? parsed.index
					: null;
			const isContentBlockStart =
				eventType === "content_block_start" ||
				parsed.type === "content_block_start";
			const isContentBlockStop =
				eventType === "content_block_stop" ||
				parsed.type === "content_block_stop";
			const isContentBlockDelta =
				eventType === "content_block_delta" ||
				parsed.type === "content_block_delta";

			if (isContentBlockStart) {
				if (
					contentBlockIndex === null ||
					openContentBlocks.has(contentBlockIndex)
				) {
					unknownContentBlockOpen = true;
					recoveryDisabled = true;
				} else {
					openContentBlocks.add(contentBlockIndex);
				}
				if (terminalDeltaSeen || provisionalTerminalDeltaSeen) {
					recoveryDisabled = true;
				}
				clearRecoveryTimer();
				return;
			}

			if (isContentBlockStop) {
				if (
					contentBlockIndex === null ||
					!openContentBlocks.has(contentBlockIndex)
				) {
					unknownContentBlockOpen = true;
					recoveryDisabled = true;
				} else {
					openContentBlocks.delete(contentBlockIndex);
				}
				if (
					terminalDeltaSeen &&
					!terminalFailureSeen &&
					!recoveryDisabled &&
					!unknownContentBlockOpen &&
					openContentBlocks.size === 0
				) {
					armRecoveryTimer();
				}
				return;
			}

			if (isContentBlockDelta) {
				if (
					contentBlockIndex === null ||
					!openContentBlocks.has(contentBlockIndex) ||
					terminalDeltaSeen ||
					provisionalTerminalDeltaSeen
				) {
					disableRecovery();
				}
				return;
			}
		}

		const isMessageDelta =
			eventType === "message_delta" || parsed.type === "message_delta";
		const stopReason = isRecord(parsed.delta)
			? parsed.delta.stop_reason
			: undefined;
		if (isMessageDelta && stopReason !== null && stopReason !== undefined) {
			if (unknownContentBlockOpen || openContentBlocks.size > 0) {
				recoveryDisabled = true;
				clearRecoveryTimer();
			}
			if (provisional) provisionalTerminalDeltaSeen = true;
			else {
				terminalDeltaSeen = true;
				provisionalTerminalDeltaSeen = false;
			}
			if (
				!terminalFailureSeen &&
				!recoveryDisabled &&
				!unknownContentBlockOpen &&
				openContentBlocks.size === 0
			) {
				armRecoveryTimer();
			}
		}
	};

	const takeBufferedEventDelimiter = (): string => {
		if (eventBuffer.length === 0) return "";
		const bufferedEvent = eventBuffer;
		eventBuffer = "";
		provisionalTerminalDeltaSeen = false;
		if (!eventBufferTruncated) inspectEvent(bufferedEvent);
		eventBufferTruncated = false;
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
		recoveryWaitRemainingMs = 0;
		recoveryWaitStartedAt = null;
		if (finalized) return;
		const missingEventDelimiter = takeBufferedEventDelimiter();
		if (messageStopSeen) {
			finalizeBufferedMessageStopAtTimeout(missingEventDelimiter);
			return;
		}
		recover("timeout", missingEventDelimiter);
	};

	const armRecoveryTimer = (): void => {
		if (
			recoveryTimer !== null ||
			finalized ||
			messageStopSeen ||
			terminalFailureSeen ||
			recoveryDisabled ||
			(!terminalDeltaSeen && !provisionalTerminalDeltaSeen) ||
			!upstreamReadPending
		)
			return;
		recoveryWaitStartedAt = Date.now();
		recoveryTimer = setTimeout(handleRecoveryTimeout, recoveryWaitRemainingMs);
	};

	const inspectChunk = (chunk: Uint8Array): void => {
		eventBuffer += decoder.decode(chunk, { stream: true });

		if (eventBufferTruncated) {
			const resyncDelimiter = /\r?\n\r?\n/.exec(eventBuffer);
			if (resyncDelimiter?.index === undefined) {
				eventBuffer = eventBuffer.slice(-3);
				return;
			}
			eventBuffer = eventBuffer.slice(
				resyncDelimiter.index + resyncDelimiter[0].length,
			);
			eventBufferTruncated = false;
		}

		let delimiter = /\r?\n\r?\n/.exec(eventBuffer);
		while (delimiter?.index !== undefined) {
			const rawEvent = eventBuffer.slice(0, delimiter.index);
			eventBuffer = eventBuffer.slice(delimiter.index + delimiter[0].length);
			provisionalTerminalDeltaSeen = false;
			if (eventBufferTruncated || rawEvent.length > MAX_PENDING_EVENT_CHARS) {
				recoveryDisabled = true;
				clearRecoveryTimer();
			} else {
				inspectEvent(rawEvent);
			}
			eventBufferTruncated = false;
			delimiter = /\r?\n\r?\n/.exec(eventBuffer);
		}

		if (eventBuffer.length > MAX_PENDING_EVENT_CHARS) {
			eventBuffer = eventBuffer.slice(-3);
			eventBufferTruncated = true;
			recoveryDisabled = true;
			clearRecoveryTimer();
			provisionalTerminalDeltaSeen = false;
			return;
		}

		if (
			!eventBufferTruncated &&
			eventBuffer.length > 0 &&
			/\r?\n$/.test(eventBuffer)
		) {
			inspectEvent(eventBuffer, true);
		}
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			downstreamController = controller;
		},

		async pull(controller) {
			if (finalized) return;

			try {
				const { value, done } = await (async () => {
					upstreamReadPending = true;
					armRecoveryTimer();
					try {
						return await reader.read();
					} finally {
						upstreamReadPending = false;
						pauseRecoveryTimer();
					}
				})();
				if (finalized) return;

				if (done) {
					eventBuffer += decoder.decode();
					const messageStopSeenBeforeBufferedEvent = messageStopSeen;
					const missingEventDelimiter = takeBufferedEventDelimiter();
					const bufferedEventSuppliedMessageStop =
						!messageStopSeenBeforeBufferedEvent && messageStopSeen;
					if (
						terminalDeltaSeen &&
						!messageStopSeen &&
						!terminalFailureSeen &&
						!recoveryDisabled &&
						!unknownContentBlockOpen &&
						openContentBlocks.size === 0
					) {
						recover("eof", missingEventDelimiter);
						return;
					}

					finalized = true;
					clearRecoveryTimer();
					if (bufferedEventSuppliedMessageStop) {
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
