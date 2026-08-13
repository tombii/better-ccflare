// Match the proxy's Anthropic precommit rescue cadence, comfortably inside
// the independent protocol-idle and socket ceilings.
export const CODEX_STREAM_HEARTBEAT_INTERVAL_MS = 25_000;
// Synthetic downstream traffic must never keep a byte-silent upstream alive
// indefinitely.
export const CODEX_STREAM_RAW_SILENCE_TIMEOUT_MS = 8 * 60_000;

export interface CodexStreamLivenessOptions {
	heartbeatIntervalMs?: number;
	rawSilenceTimeoutMs?: number;
}

export interface CodexStreamHeartbeatGate {
	isReady(): boolean;
	waitUntilReady(signal: AbortSignal): Promise<void>;
}

type CodexStreamReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read">;

type CodexUpstreamReadResult = Awaited<
	ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

export type CodexStreamLivenessOutcome =
	| {
			type: "upstream";
			result: CodexUpstreamReadResult;
	  }
	| {
			type: "upstream_error";
			error: unknown;
	  }
	| {
			type: "heartbeat_due";
	  }
	| {
			type: "raw_silence_timeout";
	  }
	| {
			type: "stopped";
	  };

type PendingReadOutcome =
	| Extract<CodexStreamLivenessOutcome, { type: "upstream" }>
	| Extract<CodexStreamLivenessOutcome, { type: "upstream_error" }>;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function requireTimerDelay(value: number, name: string): number {
	if (
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > MAX_TIMER_DELAY_MS
	) {
		throw new RangeError(
			`${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
		);
	}
	return value;
}

/**
 * Serializes upstream reads with downstream heartbeat and raw-silence
 * deadlines. A pending reader.read() is retained when a heartbeat wins the
 * race, so the provider never issues concurrent reads or bypasses its normal
 * downstream backpressure path.
 */
export class CodexStreamLiveness {
	private readonly heartbeatIntervalMs: number;
	private readonly rawSilenceTimeoutMs: number;
	private nextHeartbeatAt: number;
	private rawSilenceDeadlineAt: number;
	private pendingRead: Promise<void> | null = null;
	private settledRead: PendingReadOutcome | null = null;
	private activeTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private activeStopResolver: (() => void) | null = null;

	constructor(options: CodexStreamLivenessOptions = {}) {
		this.heartbeatIntervalMs = requireTimerDelay(
			options.heartbeatIntervalMs ?? CODEX_STREAM_HEARTBEAT_INTERVAL_MS,
			"heartbeatIntervalMs",
		);
		this.rawSilenceTimeoutMs = requireTimerDelay(
			options.rawSilenceTimeoutMs ?? CODEX_STREAM_RAW_SILENCE_TIMEOUT_MS,
			"rawSilenceTimeoutMs",
		);
		const now = performance.now();
		this.nextHeartbeatAt = now + this.heartbeatIntervalMs;
		this.rawSilenceDeadlineAt = now + this.rawSilenceTimeoutMs;
	}

	/**
	 * Record a canonical downstream frame after it has actually been enqueued.
	 * Synthetic pings move only the heartbeat cadence; they never touch the
	 * independent raw-upstream-silence deadline.
	 */
	recordDownstreamWrite(): void {
		if (this.stopped) return;
		this.nextHeartbeatAt = performance.now() + this.heartbeatIntervalMs;
	}

	/**
	 * Re-check immediately before a scheduled heartbeat enqueue. An upstream
	 * read that settled while downstream capacity was unavailable always wins.
	 */
	canEmitHeartbeat(): boolean {
		const now = performance.now();
		return (
			!this.stopped &&
			this.settledRead === null &&
			now < this.rawSilenceDeadlineAt &&
			now >= this.nextHeartbeatAt
		);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.activeTimer !== null) {
			clearTimeout(this.activeTimer);
			this.activeTimer = null;
		}
		const resolveActiveWait = this.activeStopResolver;
		this.activeStopResolver = null;
		resolveActiveWait?.();
	}

	async settlePendingReadForCleanup(): Promise<void> {
		await this.pendingRead;
		this.pendingRead = null;
		this.settledRead = null;
	}

	private ensurePendingRead(reader: CodexStreamReader): void {
		if (this.pendingRead !== null) return;
		this.pendingRead = reader.read().then(
			(result) => {
				this.settledRead = { type: "upstream", result };
			},
			(error) => {
				this.settledRead = { type: "upstream_error", error };
			},
		);
	}

	async next(
		reader: CodexStreamReader,
		heartbeatGate?: CodexStreamHeartbeatGate,
	): Promise<CodexStreamLivenessOutcome> {
		while (!this.stopped) {
			this.ensurePendingRead(reader);
			if (this.settledRead !== null) {
				const outcome = this.settledRead;
				this.settledRead = null;
				this.pendingRead = null;
				if (
					outcome.type === "upstream" &&
					!outcome.result.done &&
					outcome.result.value.byteLength > 0
				) {
					this.rawSilenceDeadlineAt =
						performance.now() + this.rawSilenceTimeoutMs;
				}
				return outcome;
			}

			let now = performance.now();
			if (now >= this.rawSilenceDeadlineAt) {
				// A stream enqueue immediately before this call resolves read() in
				// a queued microtask. Give that already-produced data one turn to
				// settle before declaring a deadline winner.
				await Promise.resolve();
				if (this.settledRead !== null) continue;
				this.stop();
				return { type: "raw_silence_timeout" };
			}
			let heartbeatDue = now >= this.nextHeartbeatAt;
			if (
				heartbeatDue &&
				(heartbeatGate === undefined || heartbeatGate.isReady())
			) {
				await Promise.resolve();
				if (this.settledRead !== null) continue;
				now = performance.now();
				if (now >= this.rawSilenceDeadlineAt) continue;
				heartbeatDue = now >= this.nextHeartbeatAt;
				if (
					heartbeatDue &&
					(heartbeatGate === undefined || heartbeatGate.isReady())
				) {
					return { type: "heartbeat_due" };
				}
			}

			const pendingRead = this.pendingRead;
			if (pendingRead === null) {
				throw new Error("Codex stream liveness lost its pending upstream read");
			}
			const delay = Math.max(
				0,
				(heartbeatDue
					? this.rawSilenceDeadlineAt
					: Math.min(this.nextHeartbeatAt, this.rawSilenceDeadlineAt)) - now,
			);
			const timerSignal = new Promise<"timer">((resolve) => {
				this.activeTimer = setTimeout(() => resolve("timer"), delay);
				(
					this.activeTimer as ReturnType<typeof setTimeout> & {
						unref?: () => void;
					}
				).unref?.();
			});
			let resolveStopped!: () => void;
			const stoppedSignal = new Promise<"stopped">((resolve) => {
				resolveStopped = () => resolve("stopped");
			});
			this.activeStopResolver = resolveStopped;
			const capacityAbortController =
				heartbeatDue && heartbeatGate !== undefined
					? new AbortController()
					: null;
			const waiters: Array<Promise<"read" | "timer" | "capacity" | "stopped">> =
				[pendingRead.then(() => "read" as const), timerSignal, stoppedSignal];
			if (capacityAbortController !== null && heartbeatGate !== undefined) {
				waiters.push(
					Promise.resolve()
						.then(() =>
							heartbeatGate.waitUntilReady(capacityAbortController.signal),
						)
						.then(() => "capacity" as const),
				);
			}
			let outcome: "read" | "timer" | "capacity" | "stopped";
			try {
				outcome = await Promise.race(waiters);
			} finally {
				if (this.activeStopResolver === resolveStopped) {
					this.activeStopResolver = null;
				}
				capacityAbortController?.abort();
				if (this.activeTimer !== null) {
					clearTimeout(this.activeTimer);
					this.activeTimer = null;
				}
			}

			if (outcome === "stopped") return { type: "stopped" };
			// Re-enter at the top so a settled upstream read is consumed before
			// a simultaneously available heartbeat/capacity signal.
		}

		return { type: "stopped" };
	}
}
