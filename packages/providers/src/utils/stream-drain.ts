/**
 * Drain a reader to `done`, dropping each chunk. `reader.cancel()` is a
 * no-op on every released Bun (oven-sh/bun#35093) and leaks the upstream's
 * native buffer; draining actually releases it. Errors are swallowed since
 * this is best-effort cleanup, not part of the caller's control flow (#382).
 */
export async function drainReader<T>(
	reader: ReadableStreamDefaultReader<T>,
): Promise<void> {
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) return;
		}
	} catch {
		// Swallow — draining must not throw during cleanup.
	} finally {
		reader.releaseLock();
	}
}

export interface DrainReaderWithDeadlineOptions {
	/**
	 * Upper bound on how long the drain will wait for `beforeDrain` (if
	 * supplied) and then for `reader.read()` to settle — one deadline shared
	 * across both phases, not a fresh one per phase. On expiry, `drainAbort`
	 * (when supplied) is aborted so the underlying fetch's connection is
	 * actually torn down — `reader.releaseLock()` alone only frees the reader
	 * object, it does not touch the connection.
	 */
	deadlineMs: number;
	drainAbort?: AbortController;
	/**
	 * Optional pre-step raced against the same deadline before the reader is
	 * touched (e.g. Codex reconciling an in-flight read owned by a liveness
	 * tracker, which allows at most one outstanding `reader.read()` at a
	 * time). Must resolve to let the drain proceed to the read loop; if the
	 * deadline wins the race instead, `drainAbort` is aborted and the
	 * function returns without touching the reader.
	 */
	beforeDrain?: () => Promise<void>;
	/**
	 * When true, errors from `beforeDrain`/`reader.read()` are swallowed
	 * (matches Codex's `drainUpstream`, which wraps the whole operation in
	 * try/catch since it's purely best-effort cleanup running detached from
	 * any caller that awaits it). When false (default), errors propagate to
	 * the caller (matches Anthropic's `drainUpstreamReader`, whose only
	 * caller either `.catch()`s the returned promise itself or returns it
	 * unchanged from the stream's native `cancel()` handler — the caller
	 * owns error handling, not the drain helper).
	 */
	swallowErrors?: boolean;
}

/**
 * Deadline-bounded, abort-capable variant of `drainReader`, shared by
 * `anthropic-terminal-recovery.ts` and Codex's `provider.ts`. See
 * `drainReader` above for why draining (not `reader.cancel()`) is needed;
 * this variant additionally bounds the wait so a stuck-but-open upstream
 * can't hold the connection open forever, and optionally reconciles a
 * pre-step (Codex's liveness handoff) before taking ownership of the reader.
 */
export async function drainReaderWithDeadline(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	options: DrainReaderWithDeadlineOptions,
): Promise<void> {
	const { deadlineMs, drainAbort, beforeDrain, swallowErrors } = options;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const runDrain = async (): Promise<void> => {
		const deadline = new Promise<"deadline">((resolve) => {
			deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
		});

		if (beforeDrain) {
			const reconciled = await Promise.race([
				beforeDrain().then(() => "settled" as const),
				deadline,
			]);
			if (reconciled === "deadline") {
				drainAbort?.abort(new Error("Drain deadline exceeded"));
				return;
			}
		}

		while (true) {
			const pendingRead = reader.read();
			const outcome = await Promise.race([pendingRead, deadline]);
			if (outcome === "deadline") {
				// `pendingRead` is still outstanding here. Releasing the lock
				// while a read is in flight only rejects that promise
				// (WHATWG Streams §4.5) — it does not tell the underlying
				// source the stream is abandoned, which is exactly the
				// "touched then abandoned" shape Bun's native fetch can
				// buffer without bound (oven-sh/bun#39590, #382). Abort
				// first so the losing read has a chance to actually settle
				// (reject) via the torn-down connection, then give it a
				// bounded grace window before releasing the lock regardless
				// — a stuck-but-unabortable source must not hang the drain.
				drainAbort?.abort(new Error("Drain deadline exceeded"));
				await Promise.race([
					pendingRead.catch(() => undefined),
					new Promise((resolve) => setTimeout(resolve, deadlineMs)),
				]);
				return;
			}
			if (outcome.done) return;
		}
	};

	try {
		await runDrain();
	} catch (error) {
		if (!swallowErrors) throw error;
		// Swallow — draining is best-effort cleanup (Codex's prior behavior).
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		reader.releaseLock();
	}
}
