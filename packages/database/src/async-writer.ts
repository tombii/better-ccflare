import type { Disposable } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";

const logger = new Logger("async-db-writer");

type DbJob = () => void | Promise<void>;

export interface AsyncWriterHealth {
	healthy: boolean;
	failureCount: number;
	recentDrops: number;
	queuedJobs: number;
}

export class AsyncDbWriter implements Disposable {
	private queue: DbJob[] = [];
	private running = false;
	private intervalId: Timer | null = null;
	private healthInterval: Timer | null = null;
	private readonly MAX_QUEUE_SIZE = 5000; // Prevent unbounded growth
	private droppedJobs = 0;
	private droppedJobsSinceLastLog = 0;
	private lastIntervalDrops = 0;

	constructor() {
		// Process queue every 100ms
		this.intervalId = setInterval(() => void this.processQueue(), 100);
		// Log health metrics every 60s when queue or drops are non-zero
		this.healthInterval = setInterval(() => {
			const recentDrops = this.droppedJobsSinceLastLog;
			this.droppedJobsSinceLastLog = 0;
			this.lastIntervalDrops = recentDrops;
			const { queuedJobs } = this.getHealth();
			if (queuedJobs > 0 || recentDrops > 0) {
				logger.warn(
					`AsyncDbWriter health: queuedJobs=${queuedJobs}, droppedJobsThisInterval=${recentDrops}`,
				);
			}
		}, 60000);
	}

	enqueue(job: DbJob): void {
		// Check queue size limit
		if (this.queue.length >= this.MAX_QUEUE_SIZE) {
			this.droppedJobs++;
			this.droppedJobsSinceLastLog++;
			if (this.droppedJobs % 100 === 1) {
				// Log every 100 dropped jobs to avoid log spam
				logger.warn(
					`Queue at capacity (${this.MAX_QUEUE_SIZE}), dropping jobs. Total dropped: ${this.droppedJobs}`,
				);
			}
			return;
		}

		this.queue.push(job);
		// Immediately try to process if not already running
		void this.processQueue();
	}

	private async processQueue(): Promise<void> {
		if (this.running || this.queue.length === 0) {
			return;
		}

		this.running = true;

		try {
			let jobsProcessed = 0;
			while (this.queue.length > 0) {
				const job = this.queue.shift();
				if (!job) continue;
				try {
					await job();
					jobsProcessed++;
				} catch (error) {
					logger.error("Failed to execute DB job", error);
				}
			}
			// Log jobs processed for debugging
			if (jobsProcessed > 0) {
				logger.debug(`Processed ${jobsProcessed} database jobs`);
			}
		} finally {
			this.running = false;
		}
	}

	getHealth(): AsyncWriterHealth {
		return {
			healthy: this.queue.length === 0 && this.lastIntervalDrops === 0,
			failureCount: this.droppedJobs,
			recentDrops: this.lastIntervalDrops,
			queuedJobs: this.queue.length,
		};
	}

	async dispose(): Promise<void> {
		logger.info("Flushing async DB writer queue...");

		// Stop the intervals
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.healthInterval) {
			clearInterval(this.healthInterval);
			this.healthInterval = null;
		}

		// Process any remaining jobs
		await this.processQueue();

		logger.info("Async DB writer queue flushed", {
			remainingJobs: this.queue.length,
			droppedJobs: this.droppedJobs,
		});
	}
}
