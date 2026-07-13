import { describe, expect, it } from "bun:test";
import { runGracefulShutdownSequence } from "./shutdown-sequence";

describe("runGracefulShutdownSequence", () => {
	it("closes admission gracefully before cleanup and waits before draining usage", async () => {
		const events: string[] = [];
		let stopArgs: boolean[] | undefined;
		let resolveStop!: () => void;
		const stopCompleted = new Promise<void>((resolve) => {
			resolveStop = resolve;
		});

		const sequence = runGracefulShutdownSequence({
			server: {
				stop: (...args: boolean[]) => {
					stopArgs = args;
					events.push("server-stop-started");
					return stopCompleted;
				},
			},
			cleanupBackgroundWork: () => {
				events.push("background-cleanup");
			},
			drainUsage: async () => {
				events.push("usage-drained");
			},
			shutdownCore: async () => {
				events.push("core-shutdown");
			},
		});

		expect(stopArgs).toEqual([]);
		expect(events).toEqual(["server-stop-started", "background-cleanup"]);

		resolveStop();
		await sequence;

		expect(events).toEqual([
			"server-stop-started",
			"background-cleanup",
			"usage-drained",
			"core-shutdown",
		]);
	});

	it("continues persistence and core cleanup when server.stop throws synchronously", async () => {
		const stopError = new Error("sync stop failure");
		const events: string[] = [];

		const sequence = runGracefulShutdownSequence({
			server: {
				stop: () => {
					events.push("server-stop");
					throw stopError;
				},
			},
			cleanupBackgroundWork: () => {
				events.push("background-cleanup");
			},
			drainUsage: async () => {
				events.push("usage-drained");
			},
			shutdownCore: async () => {
				events.push("core-shutdown");
			},
		});

		await expect(sequence).rejects.toBe(stopError);
		expect(events).toEqual([
			"server-stop",
			"background-cleanup",
			"usage-drained",
			"core-shutdown",
		]);
	});

	it("continues persistence and aggregates later failures when server.stop rejects", async () => {
		const stopError = new Error("async stop failure");
		const drainError = new Error("drain failure");
		const events: string[] = [];

		const sequence = runGracefulShutdownSequence({
			server: {
				stop: async () => {
					events.push("server-stop");
					throw stopError;
				},
			},
			cleanupBackgroundWork: () => {
				events.push("background-cleanup");
			},
			drainUsage: async () => {
				events.push("usage-drained");
				throw drainError;
			},
			shutdownCore: async () => {
				events.push("core-shutdown");
			},
		});

		try {
			await sequence;
			throw new Error("expected graceful shutdown to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([
				stopError,
				drainError,
			]);
		}
		expect(events).toEqual([
			"server-stop",
			"background-cleanup",
			"usage-drained",
			"core-shutdown",
		]);
	});
});
