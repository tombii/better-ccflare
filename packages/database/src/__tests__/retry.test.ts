/**
 * Tests for withDatabaseRetry (packages/database/src/retry.ts).
 *
 * Retries lock-contention / transient-connection errors with exponential
 * backoff; everything else fails fast. Delays are kept at 1ms so the suite
 * stays fast.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { withDatabaseRetry } from "../retry";

const FAST = { delayMs: 1, maxDelayMs: 5 };

describe("withDatabaseRetry", () => {
	test("retries SQLITE_BUSY and resolves with the success value", async () => {
		let calls = 0;
		const result = await withDatabaseRetry(() => {
			calls++;
			if (calls < 3) throw new Error("SQLITE_BUSY: database is busy");
			return "ok";
		}, FAST);
		expect(result).toBe("ok");
		expect(calls).toBe(3);
	});

	test("non-retryable error rejects immediately", async () => {
		let calls = 0;
		const err = new Error("syntax error");
		await expect(
			withDatabaseRetry(() => {
				calls++;
				throw err;
			}, FAST),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	test("retryable error on every attempt rejects with the last error after `attempts` calls", async () => {
		let calls = 0;
		const errors: Error[] = [];
		const err = await withDatabaseRetry(
			() => {
				calls++;
				const e = new Error(`database is locked (call ${calls})`);
				errors.push(e);
				throw e;
			},
			{ ...FAST, attempts: 3 },
		).catch((e: Error) => e);
		expect(err).toBe(errors[2]);
		expect(calls).toBe(3);
		expect(errors).toHaveLength(3);
	});

	test("retryable error matched by `code` is retried", async () => {
		let calls = 0;
		const result = await withDatabaseRetry(() => {
			calls++;
			if (calls === 1)
				throw Object.assign(new Error("x"), { code: "SQLITE_LOCKED" });
			return 42;
		}, FAST);
		expect(result).toBe(42);
		expect(calls).toBe(2);
	});

	test("PG transient message (deadlock detected) is retried", async () => {
		let calls = 0;
		const result = await withDatabaseRetry(() => {
			calls++;
			if (calls === 1) throw new Error("deadlock detected");
			return "ok";
		}, FAST);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	test("async operation rejecting with a retryable error is retried", async () => {
		let calls = 0;
		const result = await withDatabaseRetry(async () => {
			calls++;
			if (calls < 3)
				throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
			return "async-ok";
		}, FAST);
		expect(result).toBe("async-ok");
		expect(calls).toBe(3);
	});

	test("async operation rejecting with a non-retryable error rejects on the first call", async () => {
		let calls = 0;
		const err = new Error("syntax error");
		await expect(
			withDatabaseRetry(async () => {
				calls++;
				throw err;
			}, FAST),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	test("synchronously throwing operation is retried the same way", async () => {
		let calls = 0;
		const result = await withDatabaseRetry(() => {
			calls++;
			if (calls < 2) throw new Error("SQLITE_BUSY");
			return "sync-ok";
		}, FAST);
		expect(result).toBe("sync-ok");
		expect(calls).toBe(2);
	});

	test("synchronously throwing non-retryable error rejects immediately", async () => {
		let calls = 0;
		await expect(
			withDatabaseRetry(() => {
				calls++;
				throw new Error("syntax error");
			}, FAST),
		).rejects.toThrow("syntax error");
		expect(calls).toBe(1);
	});

	test("custom attempts config is honoured", async () => {
		let calls = 0;
		await expect(
			withDatabaseRetry(
				() => {
					calls++;
					throw new Error("SQLITE_BUSY");
				},
				{ attempts: 2, delayMs: 1, maxDelayMs: 5 },
			),
		).rejects.toThrow("SQLITE_BUSY");
		expect(calls).toBe(2);
	});

	test("backoff delay grows exponentially (with jitter) and is capped by maxDelayMs", async () => {
		const delays: number[] = [];
		const realSetTimeout = globalThis.setTimeout;
		const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: () => void,
			ms?: number,
		) => {
			delays.push(ms ?? 0);
			return realSetTimeout(fn, 0);
		}) as typeof setTimeout);

		try {
			await expect(
				withDatabaseRetry(
					() => {
						throw new Error("SQLITE_BUSY");
					},
					{ attempts: 4, delayMs: 10, backoff: 2, maxDelayMs: 25 },
				),
			).rejects.toThrow("SQLITE_BUSY");
		} finally {
			spy.mockRestore();
		}

		// attempt 0: 10..11, attempt 1: 20..22, attempt 2: 40..44 capped to 25
		expect(delays).toHaveLength(3);
		expect(delays[0]).toBeGreaterThanOrEqual(10);
		expect(delays[0]).toBeLessThanOrEqual(11);
		expect(delays[1]).toBeGreaterThanOrEqual(20);
		expect(delays[1]).toBeLessThanOrEqual(22);
		expect(delays[2]).toBe(25);
	});
});
