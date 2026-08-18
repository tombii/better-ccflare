/**
 * Drain a reader to `done`, dropping each chunk. `reader.cancel()` is a
 * no-op on every released Bun (oven-sh/bun#35093) and leaks the upstream's
 * native buffer; draining actually releases it. Errors are swallowed since
 * this is best-effort cleanup, not part of the caller's control flow (#382).
 */
export async function drainReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
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
			const outcome = await Promise.race([reader.read(), deadline]);
			if (outcome === "deadline") {
				drainAbort?.abort(new Error("Drain deadline exceeded"));
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
