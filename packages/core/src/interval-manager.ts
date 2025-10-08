/**
 * Centralized interval manager to prevent interval accumulation and provide better control
 */
import { Logger } from "@better-ccflare/logger";

const log = new Logger("IntervalManager");

export interface IntervalConfig {
	id: string;
	callback: () => void | Promise<void>;
	intervalMs: number;
	immediate?: boolean; // Run immediately on start
	maxConcurrent?: number; // For async operations
	description?: string;
}

interface ActiveInterval {
	config: IntervalConfig;
	intervalId: NodeJS.Timeout;
	lastRun: number;
	isRunning: boolean;
	runCount: number;
}

/**
 * Centralized interval manager that tracks and manages all intervals
 */
export class IntervalManager {
	private intervals = new Map<string, ActiveInterval>();
	private isShuttingDown = false;

	/**
	 * Register and start a new interval
	 */
	register(config: IntervalConfig): () => void {
		if (this.isShuttingDown) {
			log.warn(
				`Cannot register interval ${config.id} - manager is shutting down`,
			);
			return () => {};
		}

		// Remove existing interval with same ID
		if (this.intervals.has(config.id)) {
			log.warn(`Interval ${config.id} already exists, replacing it`);
			this.unregister(config.id);
		}

		const wrappedCallback = this.createWrappedCallback(config);
		const intervalId = setInterval(wrappedCallback, config.intervalMs);

		const activeInterval: ActiveInterval = {
			config,
			intervalId,
			lastRun: 0,
			isRunning: false,
			runCount: 0,
		};

		this.intervals.set(config.id, activeInterval);

		// Run immediately if requested
		if (config.immediate) {
			wrappedCallback();
		}

		log.debug(
			`Registered interval ${config.id} (${config.intervalMs}ms)${config.description ? ` - ${config.description}` : ""}`,
		);

		// Return cleanup function
		return () => this.unregister(config.id);
	}

	/**
	 * Unregister and stop an interval
	 */
	unregister(id: string): boolean {
		const interval = this.intervals.get(id);
		if (!interval) {
			return false;
		}

		clearInterval(interval.intervalId);
		this.intervals.delete(id);

		log.debug(`Unregistered interval ${id} (ran ${interval.runCount} times)`);
		return true;
	}

	/**
	 * Get information about all registered intervals
	 */
	getIntervalInfo(): Array<{
		id: string;
		intervalMs: number;
		lastRun: number;
		isRunning: boolean;
		runCount: number;
		description?: string;
	}> {
		return Array.from(this.intervals.entries()).map(([id, interval]) => ({
			id,
			intervalMs: interval.config.intervalMs,
			lastRun: interval.lastRun,
			isRunning: interval.isRunning,
			runCount: interval.runCount,
			description: interval.config.description,
		}));
	}

	/**
	 * Check if an interval is registered
	 */
	has(id: string): boolean {
		return this.intervals.has(id);
	}

	/**
	 * Get the number of active intervals
	 */
	getActiveCount(): number {
		return this.intervals.size;
	}

	/**
	 * Stop all intervals and prepare for shutdown
	 */
	shutdown(): void {
		log.info(
			`Shutting down interval manager - stopping ${this.intervals.size} intervals`,
		);
		this.isShuttingDown = true;

		for (const [_id, interval] of this.intervals.entries()) {
			clearInterval(interval.intervalId);
		}

		const count = this.intervals.size;
		this.intervals.clear();
		log.info(`Stopped ${count} intervals`);
	}

	/**
	 * Create a wrapped callback with error handling and tracking
	 */
	private createWrappedCallback(config: IntervalConfig): () => void {
		return async () => {
			const interval = this.intervals.get(config.id);
			if (!interval || this.isShuttingDown) {
				return;
			}

			// Skip if already running (for async operations)
			if (interval.isRunning && config.maxConcurrent === 1) {
				log.debug(`Skipping interval ${config.id} - already running`);
				return;
			}

			interval.isRunning = true;
			interval.lastRun = Date.now();
			interval.runCount++;

			try {
				await config.callback();
			} catch (error) {
				log.error(`Error in interval ${config.id}:`, error);
			} finally {
				interval.isRunning = false;
			}
		};
	}

	/**
	 * Update interval timing
	 */
	updateInterval(id: string, newIntervalMs: number): boolean {
		const interval = this.intervals.get(id);
		if (!interval) {
			return false;
		}

		// Stop current interval
		clearInterval(interval.intervalId);

		// Start new interval with updated timing
		const wrappedCallback = this.createWrappedCallback(interval.config);
		interval.intervalId = setInterval(wrappedCallback, newIntervalMs);
		interval.config.intervalMs = newIntervalMs;

		log.debug(`Updated interval ${id} to ${newIntervalMs}ms`);
		return true;
	}
}

// Global singleton instance
export const intervalManager = new IntervalManager();

/**
 * Convenience functions for common patterns
 */

/**
 * Register a UI refresh interval with automatic cleanup
 */
export function registerUIRefresh(config: {
	id: string;
	callback: () => void | Promise<void>;
	seconds: number;
	description?: string;
}): () => void {
	return intervalManager.register({
		...config,
		intervalMs: config.seconds * 1000,
		immediate: true,
		description: config.description || `UI refresh every ${config.seconds}s`,
	});
}

/**
 * Register a cleanup interval with error handling
 */
export function registerCleanup(config: {
	id: string;
	callback: () => void | Promise<void>;
	minutes?: number;
	description?: string;
}): () => void {
	return intervalManager.register({
		...config,
		intervalMs: (config.minutes ?? 5) * 60 * 1000,
		description:
			config.description || `Cleanup every ${config.minutes ?? 5}min`,
	});
}

/**
 * Register a heartbeat interval with connection management
 */
export function registerHeartbeat(config: {
	id: string;
	callback: () => void | Promise<void>;
	seconds?: number;
	description?: string;
}): () => void {
	return intervalManager.register({
		...config,
		intervalMs: (config.seconds ?? 30) * 1000,
		maxConcurrent: 1,
		description:
			config.description || `Heartbeat every ${config.seconds ?? 30}s`,
	});
}

// Graceful shutdown on process exit
if (typeof process !== "undefined") {
	process.on("SIGINT", () => {
		intervalManager.shutdown();
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		intervalManager.shutdown();
		process.exit(0);
	});
}
