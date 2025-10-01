import type { Disposable } from "@ccflare/core";
import { Logger } from "@ccflare/logger";

const logger = new Logger("async-db-writer");

type DbJob = () => void | Promise<void>;

export class AsyncDbWriter implements Disposable {
	private queue: DbJob[] = [];
	private running = false;
	private intervalId: Timer | null = null;
	private readonly MAX_QUEUE_SIZE = 10000; // Prevent unbounded growth
	private droppedJobs = 0;

	constructor() {
		// Process queue every 100ms
		this.intervalId = setInterval(() => void this.processQueue(), 100);
	}

	enqueue(job: DbJob): void {
		// Check queue size limit
		if (this.queue.length >= this.MAX_QUEUE_SIZE) {
			this.droppedJobs++;
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
			while (this.queue.length > 0) {
				const job = this.queue.shift();
				if (!job) continue;
				try {
					await job();
				} catch (error) {
					logger.error("Failed to execute DB job", error);
				}
			}
		} finally {
			this.running = false;
		}
	}

	async dispose(): Promise<void> {
		logger.info("Flushing async DB writer queue...");

		// Stop the interval
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		// Process any remaining jobs
		await this.processQueue();

		logger.info("Async DB writer queue flushed", {
			remainingJobs: this.queue.length,
			droppedJobs: this.droppedJobs,
		});
	}
}
