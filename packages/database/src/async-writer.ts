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
	private running = false;
	private intervalId: Timer | null = null;
	private healthInterval: Timer | null = null;

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
		const watchdog = setTimeout(() => {
			logger.warn(
				`DB job stuck: kind=${kind} requestId=${job.requestId ?? "n/a"} elapsed_ms=${Math.round(performance.now() - t0)}`,
			);
		}, 5000);
		try {
			await job.run();
		} catch (err) {
			logger.error(
				`DB job failed: kind=${kind} requestId=${job.requestId ?? "n/a"}`,
				err,
			);
		} finally {
			clearTimeout(watchdog);
			// finally-safety: bytes counter must decrement on every payload completion
			// (success OR error), otherwise a single throwing job would permanently
			// inflate payloadBytesPending and eventually wedge admission.
			if (kind === "payload") {
				this.payloadBytesPending -= (job as PayloadJob).bytes;
			}
			const dur = performance.now() - t0;
			if (dur > 1000) {
				logger.warn(
					`Slow DB job: kind=${kind} dur_ms=${Math.round(dur)} requestId=${job.requestId ?? "n/a"}`,
				);
			}
		}
	}

	private async processQueue(): Promise<void> {
		if (
			this.running ||
			(this.metadataQueue.length === 0 && this.payloadQueue.length === 0)
		) {
			return;
		}

		this.running = true;
		const start = performance.now();
		let jobsProcessed = 0;

		try {
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
		} finally {
			this.running = false;
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
		// call it in a loop until both queues are empty.
		while (this.metadataQueue.length > 0 || this.payloadQueue.length > 0) {
			await this.processQueue();
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
