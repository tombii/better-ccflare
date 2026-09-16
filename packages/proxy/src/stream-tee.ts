import { BUFFER_SIZES } from "@better-ccflare/core";

/**
 * Tees a ReadableStream to capture data without blocking the original stream.
 * Allows buffering stream content for analytics while maintaining streaming performance.
 */
export function teeStream(
	upstream: ReadableStream<Uint8Array>,
	options: {
		onChunk?: (chunk: Uint8Array) => void;
		onClose?: (buffered: Uint8Array[]) => void;
		onError?: (error: Error) => void;
		maxBytes?: number; // Max bytes to buffer (default: 1MB)
		/**
		 * Fired synchronously at the start of `cancel()`, alongside `onClose`
		 * — i.e. exactly when the client disconnects — but BEFORE the
		 * drain-to-done loop below runs. Distinct from `onClose`: this exists
		 * so a caller wrapping an inner stream (e.g.
		 * `createAnthropicTerminalRecoveryStream`) can flag the disconnect on
		 * a side channel (see its `clientDisconnectSignal` option) without
		 * this function ever calling the inner stream's own `.cancel()` —
		 * doing that would short-circuit the drain loop below and reintroduce
		 * the Bun native-buffer leak (#273, see the comment further down).
		 */
		onCancel?: () => void;
	} = {},
): ReadableStream<Uint8Array> {
	const {
		onChunk,
		onClose,
		onError,
		onCancel,
		maxBytes = BUFFER_SIZES.STREAM_TEE_MAX_BYTES,
	} = options;
	const reader = upstream.getReader();
	const buffered: Uint8Array[] = [];
	let totalBytes = 0;
	let truncated = false;

	return new ReadableStream({
		async pull(controller) {
			try {
				const { value, done } = await reader.read();

				if (done) {
					onClose?.(buffered);
					controller.close();
					reader.releaseLock();
					return;
				}

				// Pass through to client immediately
				controller.enqueue(value);

				// Buffer for analytics if under limit
				if (!truncated && totalBytes + value.length <= maxBytes) {
					buffered.push(value);
					totalBytes += value.length;
				} else if (!truncated) {
					truncated = true;
					// Still buffer this chunk partially to reach exactly maxBytes
					const remaining = maxBytes - totalBytes;
					if (remaining > 0) {
						buffered.push(value.slice(0, remaining));
						totalBytes = maxBytes;
					}
				}

				// Notify chunk handler
				onChunk?.(value);
			} catch (error) {
				onError?.(error as Error);
				controller.error(error);
				reader.releaseLock();
			}
		},

		cancel() {
			// onCancel fires first, synchronously, so a caller wiring it to a
			// side-channel signal (see createAnthropicTerminalRecoveryStream's
			// `clientDisconnectSignal`) has that signal set BEFORE onClose
			// reads any state derived from it — onClose fires immediately
			// below rather than waiting on the async drain, so anything it
			// needs from the inner stream's terminal-state determination must
			// already be in place by this point.
			onCancel?.();

			// A client-initiated cancel (Esc, tab close, network drop) must
			// finalize the same way a clean `done` does — otherwise the
			// caller's onClose (and whatever it drives, e.g. usage-collector's
			// per-request state) never fires and the entry only gets reclaimed
			// by the collector's periodic stale-request sweep, up to
			// CF_STREAM_TIMEOUT_MS later.
			onClose?.(buffered);

			// reader.cancel() is a no-op on Bun (oven-sh/bun#35093) and leaks
			// the upstream's native buffer; drain to `done` instead — see
			// handlers/discard-body-cancel.ts for the full rationale (#382).
			// Bounded by the caller's fetch() abort signal (request-handler.ts's
			// effectiveSignal), which rejects reader.read() once the same
			// client disconnect that triggered this cancel() propagates there.
			void (async () => {
				try {
					while (true) {
						const { done } = await reader.read();
						if (done) return;
					}
				} catch {
					// Swallow — cancel() must not throw during teardown.
				} finally {
					reader.releaseLock();
				}
			})();
		},
	});
}

/**
 * Combines buffered chunks into a single Buffer
 */
export function combineChunks(chunks: Uint8Array[]): Buffer {
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const combined = Buffer.allocUnsafe(totalLength);
	let offset = 0;

	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}

	return combined;
}
