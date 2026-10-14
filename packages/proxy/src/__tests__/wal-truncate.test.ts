/**
 * Tests for the periodic WAL TRUNCATE job (packages/proxy/src/wal-truncate.ts).
 *
 * Uses a mock DatabaseOperations so we only observe `truncateWal()` calls;
 * the checkpoint itself is covered in packages/database
 * (`wal-truncate.test.ts`).
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { intervalManager } from "@better-ccflare/core";
import type {
	DatabaseOperations,
	WalTruncateResult,
} from "@better-ccflare/database";
import {
	startWalTruncateJob,
	truncateWalAfterIntegrityCheck,
	truncateWalQuietly,
} from "../wal-truncate";

function makeDbOps(
	opts: {
		isSQLite?: boolean;
		truncateWal?: () => WalTruncateResult | null;
	} = {},
) {
	const truncateWal = mock(
		opts.truncateWal ??
			((): WalTruncateResult => ({ busy: false, log: 0, checkpointed: 0 })),
	);
	return {
		dbOps: {
			isSQLite: opts.isSQLite ?? true,
			truncateWal,
		} as unknown as DatabaseOperations,
		truncateWal,
	};
}

afterEach(() => {
	delete process.env.CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES;
});

describe("startWalTruncateJob", () => {
	const registered = () => intervalManager.has("wal-truncate");

	it("registers a 10-minute job by default that runs truncateWal, and stops cleanly", async () => {
		const registerSpy = spyOn(intervalManager, "register");
		const { dbOps, truncateWal } = makeDbOps();
		const stop = startWalTruncateJob(dbOps);
		try {
			expect(registered()).toBe(true);
			const config = registerSpy.mock.calls.at(-1)?.[0];
			expect(config?.id).toBe("wal-truncate");
			expect(config?.intervalMs).toBe(10 * 60 * 1000);
			expect(await intervalManager.runNow("wal-truncate")).toBe(true);
			expect(truncateWal).toHaveBeenCalledTimes(1);
		} finally {
			stop();
			registerSpy.mockRestore();
		}
		expect(registered()).toBe(false);
	});

	it("honours CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES", () => {
		process.env.CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES = "3";
		const registerSpy = spyOn(intervalManager, "register");
		const { dbOps } = makeDbOps();
		const stop = startWalTruncateJob(dbOps);
		try {
			expect(registerSpy.mock.calls.at(-1)?.[0]?.intervalMs).toBe(
				3 * 60 * 1000,
			);
		} finally {
			stop();
			registerSpy.mockRestore();
		}
	});

	it("CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES=0 disables the job", () => {
		process.env.CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES = "0";
		const { dbOps } = makeDbOps();
		const stop = startWalTruncateJob(dbOps);
		expect(registered()).toBe(false);
		expect(() => stop()).not.toThrow();
	});

	it("override intervalMinutes=0 disables the job", () => {
		const { dbOps } = makeDbOps();
		const stop = startWalTruncateJob(dbOps, { intervalMinutes: 0 });
		expect(registered()).toBe(false);
		stop();
	});

	it("is a no-op for non-SQLite backends", () => {
		const { dbOps } = makeDbOps({ isSQLite: false });
		const stop = startWalTruncateJob(dbOps);
		expect(registered()).toBe(false);
		stop();
	});
});

describe("truncateWalQuietly", () => {
	it("calls truncateWal once", () => {
		const { dbOps, truncateWal } = makeDbOps();
		truncateWalQuietly(dbOps, "test");
		expect(truncateWal).toHaveBeenCalledTimes(1);
	});

	it("does not throw on a busy result", () => {
		const { dbOps } = makeDbOps({
			truncateWal: () => ({ busy: true, log: 10, checkpointed: 4 }),
		});
		expect(() => truncateWalQuietly(dbOps, "test")).not.toThrow();
	});

	it("does not throw on a locked result", () => {
		const { dbOps } = makeDbOps({
			truncateWal: () => ({
				busy: true,
				log: -1,
				checkpointed: -1,
				error: "database table is locked",
			}),
		});
		expect(() => truncateWalQuietly(dbOps, "test")).not.toThrow();
	});

	it("does not throw if truncateWal itself throws", () => {
		const { dbOps } = makeDbOps({
			truncateWal: () => {
				throw new Error("SQLITE_BUSY");
			},
		});
		expect(() => truncateWalQuietly(dbOps, "test")).not.toThrow();
	});
});

describe("truncateWalAfterIntegrityCheck", () => {
	it("truncates by default", () => {
		const { dbOps, truncateWal } = makeDbOps();
		truncateWalAfterIntegrityCheck(dbOps);
		expect(truncateWal).toHaveBeenCalledTimes(1);
	});

	it("is skipped when the periodic job is disabled", () => {
		process.env.CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES = "0";
		const { dbOps, truncateWal } = makeDbOps();
		truncateWalAfterIntegrityCheck(dbOps);
		expect(truncateWal).not.toHaveBeenCalled();
	});
});
