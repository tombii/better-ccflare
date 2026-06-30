import type { Disposable } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";

const logger = new Logger("async-db-writer");

type DbJob = () => void | Promise<void>;

type MetadataJob = {
	requestId?: string;
	enqueuedAt: number;
	run: () => Promise<void> | void;
};

type PayloadJob = {
	requestId: string;
	bytes: number;
	enqueuedAt: number;
	run: () => Promise<void> | void;
};

export interface AsyncWriterHealth {
	healthy: boolean;
	failureCount: number;
	recentDrops: number;
	queuedJobs: number;
	metadataQueuedJobs: number;
	payloadQueuedJobs: number;
	payloadBytesPending: number;
	oldestMetadataAgeMs: number;
	oldestPayloadAgeMs: number;
	metadataDropped: number;
	payloadDropped: number;
	payloadDroppedBytes: number;
}

export class AsyncDbWriter implements Disposable {
	private metadataQueue: MetadataJob[] = [];
	private payloadQueue: PayloadJob[] = [];
	private payloadBytesPending = 0;
	// Tracks the currently-executing tick. dispose() and re-entrant callers
	// await this so a tick that has already shift()-ed its last job (queues
	// empty) but is still inside its job's `finally` is not abandoned.
	private runningPromise: Promise<void> | null = null;
	private intervalId: Timer | null = null;
	private healthInterval: Timer | null = null;
	// Jobs whose Promise.race was won by the hard-abort timer. The underlying
	// job.run() may still be in-flight (Promises can't be cancelled). We track
	// them so dispose() can wait for them before returning.
	private abandonedJobs: Set<Promise<unknown>> = new Set();

	private readonly METADATA_QUEUE_CAP = 2000;
	private readonly PAYLOAD_QUEUE_HARD_CAP = 1000;
	private readonly PAYLOAD_BYTES_CAP = 100 * 1024 * 1024;

	// Round-robin ratio: drain METADATA_PER_PAYLOAD metadata jobs (small, fast inserts)
	// before each payload job (large, slow blob write) so a flood of payloads cannot
	// starve metadata insertion and vice versa.
	private readonly METADATA_PER_PAYLOAD = 100;

	// Dual budget: cap by both job count and wall-clock so a few slow jobs cannot
	// monopolize the tick and so a queue of trivial jobs cannot starve the event
	// loop. The 100ms setInterval restart resumes drain after we yield.
	private readonly MAX_JOBS_PER_TICK = 50;
	private readonly MAX_DRAIN_MS_PER_TICK = 250;

	private metadataDropped = 0;
	private payloadDropped = 0;
	private payloadDroppedBytes = 0;
	private droppedJobsSinceLastLog = 0;
	private payloadDroppedSinceLastLog = 0;
	private lastIntervalDrops = 0;

	// Persists across processQueue ticks. If kept local, the streak resets every
	// time we yield (every ~50 jobs / 250 ms), and since the streak threshold
	// (METADATA_PER_PAYLOAD=100) is higher than MAX_JOBS_PER_TICK (50), payloads
	// would never get a turn until the metadata queue fully drains — exactly the
	// starvation Codex warned about. Instance scope makes the round-robin honor
	// the ratio across the full backlog, not just within one tick.
	private metadataStreak = 0;

	constructor() {
		this.intervalId = setInterval(() => void this.processQueue(), 100);
		this.healthInterval = setInterval(() => {
			const recentDrops =
				this.droppedJobsSinceLastLog + this.payloadDroppedSinceLastLog;
			this.droppedJobsSinceLastLog = 0;
			this.payloadDroppedSinceLastLog = 0;
			this.lastIntervalDrops = recentDrops;
			const h = this.getHealth();
			if (h.queuedJobs > 0 || recentDrops > 0) {
				logger.warn(
					`AsyncDbWriter health: metadataQueued=${h.metadataQueuedJobs}, payloadQueued=${h.payloadQueuedJobs}, payloadBytesPending=${h.payloadBytesPending}, oldestMetadataAgeMs=${h.oldestMetadataAgeMs}, oldestPayloadAgeMs=${h.oldestPayloadAgeMs}, metadataDropped=${h.metadataDropped}, payloadDropped=${h.payloadDropped}, payloadDroppedBytes=${h.payloadDroppedBytes}, droppedThisInterval=${recentDrops}`,
				);
			}
		}, 30000);
	}

	enqueue(job: DbJob): void {
		if (this.metadataQueue.length >= this.METADATA_QUEUE_CAP) {
			this.metadataDropped++;
			this.droppedJobsSinceLastLog++;
			if (this.metadataDropped % 100 === 1) {
				logger.warn(
					`Metadata queue at capacity (${this.METADATA_QUEUE_CAP}), dropping jobs. Total dropped: ${this.metadataDropped}`,
				);
			}
			return;
		}

		this.metadataQueue.push({
			enqueuedAt: performance.now(),
			run: job,
		});
		void this.processQueue();
	}

	canAcceptPayload(estimatedBytes: number): boolean {
		if (this.payloadQueue.length >= this.PAYLOAD_QUEUE_HARD_CAP) return false;
		if (this.payloadBytesPending + estimatedBytes > this.PAYLOAD_BYTES_CAP)
			return false;
		return true;
	}

	/**
	 * Record a payload drop that did not go through `enqueuePayload` — i.e., a
	 * caller that ran the cheap `canAcceptPayload` preflight and elected to skip
	 * serialization. Without this the drop counters miss every preflight reject,
	 * leaving `getHealth().payloadDropped` blind under sustained backpressure
	 * and suppressing the 30s health log line (which gates on `recentDrops > 0`).
	 */
	recordPayloadDrop(bytes: number): void {
		this.payloadDropped++;
		this.payloadDroppedBytes += bytes;
		this.payloadDroppedSinceLastLog++;
		if (this.payloadDropped % 100 === 1) {
			logger.warn(
				`Payload preflight reject (bytes=${bytes}, queued=${this.payloadQueue.length}, bytesPending=${this.payloadBytesPending}). Total dropped: ${this.payloadDropped}`,
			);
		}
	}

	enqueuePayload(
		requestId: string,
		bytes: number,
		run: () => Promise<void> | void,
	): boolean {
		// Re-check inside the method: canAcceptPayload is a lock-free advisory probe,
		// but the real admission decision must be made here because the counters can
		// shift between the caller's probe and the actual push.
		if (
			this.payloadQueue.length >= this.PAYLOAD_QUEUE_HARD_CAP ||
			this.payloadBytesPending + bytes > this.PAYLOAD_BYTES_CAP
		) {
			this.payloadDropped++;
			this.payloadDroppedBytes += bytes;
			this.payloadDroppedSinceLastLog++;
			if (this.payloadDropped % 100 === 1) {
				logger.warn(
					`Payload queue at capacity (queued=${this.payloadQueue.length}, bytesPending=${this.payloadBytesPending}, incomingBytes=${bytes}), dropping. Total dropped: ${this.payloadDropped}`,
				);
			}
			return false;
		}

		this.payloadBytesPending += bytes;
		this.payloadQueue.push({
			requestId,
			bytes,
			enqueuedAt: performance.now(),
			run,
		});
		void this.processQueue();
		return true;
	}

	private async runJobWithWatchdog(
		job: MetadataJob | PayloadJob,
		kind: "metadata" | "payload",
	): Promise<void> {
		const t0 = performance.now();
		const rid = job.requestId ?? "n/a";

		let hardReject!: (e: Error) => void;
		const abortPromise = new Promise<never>((_, reject) => {
			hardReject = reject;
		});

		const warnTimer = setTimeout(() => {
			logger.warn(
				`DB job stuck: kind=${kind} requestId=${rid} elapsed_ms=${Math.round(performance.now() - t0)}`,
			);
		}, 5000);

		const abortTimer = setTimeout(() => {
			hardReject(
				new Error(
					`DB job hard-aborted after 30s: kind=${kind} requestId=${rid}`,
				),
			);
		}, 30000);

		// Eagerly resolve the job into a named promise so we can track it if the
		// abort timer fires first (the job may still be in-flight — Promises
		// cannot be cancelled, but we can wait for it in dispose()).
		const jobPromise = Promise.resolve(job.run());

		// decrementBytes ensures payloadBytesPending is adjusted exactly once,
		// whether the job completes normally or is abandoned after a hard-abort.
		const decrementBytes = (() => {
			let done = false;
			return () => {
				if (done) return;
				done = true;
				if (kind === "payload") {
					this.payloadBytesPending -= (job as PayloadJob).bytes;
				}
			};
		})();

		try {
			await Promise.race([jobPromise, abortPromise]);
		} catch (err) {
			const isHardAbort =
				err instanceof Error && err.message.startsWith("DB job hard-aborted");

			if (isHardAbort) {
				// The queue can advance, but the underlying job.run() is still
				// in-flight. Track it so dispose() waits before shutting down.
				const tracked = jobPromise
					.catch(() => {})
					.finally(() => {
						decrementBytes();
						this.abandonedJobs.delete(tracked);
					});
				this.abandonedJobs.add(tracked);
			}

			logger.error(`DB job failed: kind=${kind} requestId=${rid}`, err);
		} finally {
			clearTimeout(warnTimer);
			clearTimeout(abortTimer);
			// Decrement bytes for the normal (non-aborted) path. The once-guard
			// inside decrementBytes prevents a double-decrement if the abandoned
			// job's finally also calls it.
			decrementBytes();
			const dur = performance.now() - t0;
			if (dur > 1000) {
				logger.warn(
					`Slow DB job: kind=${kind} dur_ms=${Math.round(dur)} requestId=${rid}`,
				);
			}
		}
	}

	private async processQueue(): Promise<void> {
		// Coalesce concurrent invocations onto the in-flight tick so callers can
		// observe its completion. Without this dispose() can return while a
		// shift()-ed job is mid-execution (queue length 0, finally not yet run).
		if (this.runningPromise) {
			return this.runningPromise;
		}
		if (this.metadataQueue.length === 0 && this.payloadQueue.length === 0) {
			return;
		}

		this.runningPromise = this.runTick();
		try {
			await this.runningPromise;
		} finally {
			this.runningPromise = null;
		}
	}

	private async runTick(): Promise<void> {
		const start = performance.now();
		let jobsProcessed = 0;

		while (
			(this.metadataQueue.length > 0 || this.payloadQueue.length > 0) &&
			jobsProcessed < this.MAX_JOBS_PER_TICK &&
			performance.now() - start < this.MAX_DRAIN_MS_PER_TICK
		) {
			const preferPayload =
				this.metadataStreak >= this.METADATA_PER_PAYLOAD &&
				this.payloadQueue.length > 0;

			if (
				!preferPayload &&
				this.metadataQueue.length > 0 &&
				this.metadataStreak < this.METADATA_PER_PAYLOAD
			) {
				const job = this.metadataQueue.shift();
				if (job) {
					await this.runJobWithWatchdog(job, "metadata");
					this.metadataStreak++;
					jobsProcessed++;
				}
				continue;
			}

			if (this.payloadQueue.length > 0) {
				const job = this.payloadQueue.shift();
				if (job) {
					await this.runJobWithWatchdog(job, "payload");
					this.metadataStreak = 0;
					jobsProcessed++;
				}
				continue;
			}

			// No payload available but we hit the metadata streak — fall through
			// to metadata if any remain, otherwise break.
			if (this.metadataQueue.length > 0) {
				const job = this.metadataQueue.shift();
				if (job) {
					await this.runJobWithWatchdog(job, "metadata");
					this.metadataStreak++;
					jobsProcessed++;
				}
				continue;
			}
			break;
		}

		if (jobsProcessed > 0) {
			logger.debug(`Processed ${jobsProcessed} database jobs`);
		}
	}

	getHealth(): AsyncWriterHealth {
		const now = performance.now();
		const oldestMetadataAgeMs =
			this.metadataQueue.length > 0
				? Math.round(now - this.metadataQueue[0].enqueuedAt)
				: 0;
		const oldestPayloadAgeMs =
			this.payloadQueue.length > 0
				? Math.round(now - this.payloadQueue[0].enqueuedAt)
				: 0;
		const queuedJobs = this.metadataQueue.length + this.payloadQueue.length;
		return {
			healthy:
				this.metadataQueue.length < this.METADATA_QUEUE_CAP * 0.8 &&
				this.payloadQueue.length < this.PAYLOAD_QUEUE_HARD_CAP * 0.8 &&
				this.payloadBytesPending < this.PAYLOAD_BYTES_CAP * 0.8 &&
				this.lastIntervalDrops === 0,
			failureCount: this.metadataDropped + this.payloadDropped,
			recentDrops: this.lastIntervalDrops,
			queuedJobs,
			metadataQueuedJobs: this.metadataQueue.length,
			payloadQueuedJobs: this.payloadQueue.length,
			payloadBytesPending: this.payloadBytesPending,
			oldestMetadataAgeMs,
			oldestPayloadAgeMs,
			metadataDropped: this.metadataDropped,
			payloadDropped: this.payloadDropped,
			payloadDroppedBytes: this.payloadDroppedBytes,
		};
	}

	async dispose(): Promise<void> {
		logger.info("Flushing async DB writer queue...");

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.healthInterval) {
			clearInterval(this.healthInterval);
			this.healthInterval = null;
		}

		// Drain both queues to completion. processQueue is budgeted per-tick;
		// call it in a loop until both queues are empty AND no in-flight tick
		// is still running (the latter covers the race where the last job has
		// been shift()-ed off but its `finally` block has not yet executed).
		while (
			this.metadataQueue.length > 0 ||
			this.payloadQueue.length > 0 ||
			this.runningPromise
		) {
			await this.processQueue();
		}

		// Wait for any jobs that were hard-aborted from the queue but whose
		// underlying job.run() promise is still in-flight. Without this, dispose()
		// could return while an abandoned write is still using the database.
		// Bounded by its own timeout — these jobs already exceeded the 30s
		// hard-abort and may never settle (e.g. a connection stuck below the PG
		// statement_timeout), so an unbounded wait here would just relocate the
		// hang from runJobWithWatchdog into dispose() and stall process shutdown.
		if (this.abandonedJobs.size > 0) {
			const pending = this.abandonedJobs.size;
			logger.info(`Waiting for ${pending} abandoned job(s) to settle...`);
			const settled = await Promise.race([
				Promise.allSettled([...this.abandonedJobs]).then(() => true),
				new Promise<false>((resolve) =>
					setTimeout(() => resolve(false), 10_000),
				),
			]);
			if (!settled) {
				logger.warn(
					`Giving up waiting on ${this.abandonedJobs.size} abandoned job(s) after 10s; shutdown proceeding without them`,
				);
			}
		}

		logger.info("Async DB writer queue flushed", {
			remainingMetadataJobs: this.metadataQueue.length,
			remainingPayloadJobs: this.payloadQueue.length,
			payloadBytesPending: this.payloadBytesPending,
			metadataDropped: this.metadataDropped,
			payloadDropped: this.payloadDropped,
			payloadDroppedBytes: this.payloadDroppedBytes,
		});
	}
}
