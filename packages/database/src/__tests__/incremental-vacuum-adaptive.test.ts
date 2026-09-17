/**
 * Tests for the adaptive incremental-vacuum backstop:
 *   - `DatabaseOperations.getFreelistCount()` — a small PRAGMA reader.
 *   - `DatabaseOperations.incrementalVacuumAdaptive()` — drives the
 *     single-chunk `incrementalVacuum()` primitive in bounded chunks so the
 *     file actually shrinks after a retention drop (large freelist) while
 *     keeping each write transaction small.
 *
 * These run against a real on-disk temp DB. A fresh DB constructed through
 * `DatabaseOperations` is born in auto_vacuum=INCREMENTAL (2) via the schema
 * bootstrap, which is what makes `PRAGMA incremental_vacuum(N)` actually
 * return free pages to the OS.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";

function tempDbPath(): string {
	return join(
		tmpdir(),
		`test-incvac-adaptive-${randomBytes(6).toString("hex")}.db`,
	);
}

/**
 * Insert `count` request + payload rows with a `bytesPerRow`-ish JSON blob so
 * the on-disk file grows by a few hundred KB. request_payloads.id is a FK to
 * requests(id) (cascade), and foreign_keys is ON, so the parent request row
 * must exist first.
 */
async function seedRows(
	dbOps: DatabaseOperations,
	count: number,
	bytesPerRow: number,
): Promise<void> {
	const adapter = dbOps.getAdapter();
	const blob = "x".repeat(bytesPerRow);
	const now = Date.now();
	for (let i = 0; i < count; i++) {
		const id = `seed-${i}-${now}`;
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, error_message, response_time_ms, failover_attempts)
			 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
			[id, now],
		);
		await adapter.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[id, blob, now],
		);
	}
}

describe("DatabaseOperations.getFreelistCount", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(async () => {
		await dbOps.dispose?.();
	});

	it("returns a number >= 0 on a fresh DB", () => {
		const n = dbOps.getFreelistCount();
		expect(typeof n).toBe("number");
		expect(n).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(n)).toBe(true);
	});
});

describe("DatabaseOperations.incrementalVacuumAdaptive", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(async () => {
		await dbOps.dispose?.();
	});

	it("returns { reclaimedPages: 0, chunks: 0 } quickly when there are no free pages", async () => {
		// Fresh DB → no deletions → empty freelist → early return.
		expect(dbOps.getFreelistCount()).toBe(0);
		const r = await dbOps.incrementalVacuumAdaptive();
		expect(r.reclaimedPages).toBe(0);
		expect(r.chunks).toBe(0);
	});

	it("shrinks the freelist end-to-end after a bulk delete (auto_vacuum=INCREMENTAL)", async () => {
		const adapter = dbOps.getAdapter();

		// Sanity: fresh DB through DatabaseOperations is in INCREMENTAL (2).
		const { auto_vacuum } = adapter
			.getSQLiteDb()
			.query("PRAGMA auto_vacuum")
			.get() as { auto_vacuum: number };
		expect(auto_vacuum).toBe(2);

		// Grow the file: ~2000 rows of ~512 bytes of JSON ≈ ~1 MB of payload.
		await seedRows(dbOps, 2000, 512);

		// Delete everything (cascade removes payloads too).
		await adapter.run(`DELETE FROM requests`, []);

		// Checkpoint the WAL so the freed pages land on the main-file freelist.
		await adapter.run(`PRAGMA wal_checkpoint(TRUNCATE)`, []);

		const freeBefore = dbOps.getFreelistCount();
		expect(freeBefore).toBeGreaterThan(0);

		const r = await dbOps.incrementalVacuumAdaptive({
			chunkPages: 64,
			maxPagesPerTick: 100000,
		});

		const freeAfter = dbOps.getFreelistCount();
		expect(freeAfter).toBeLessThan(freeBefore);
		expect(r.reclaimedPages).toBeGreaterThan(0);
		expect(r.chunks).toBeGreaterThan(0);
		// With a generous per-tick budget the freelist should fully drain.
		expect(freeAfter).toBe(0);
	});

	it("respects maxPagesPerTick (bounds the number of chunks)", async () => {
		const adapter = dbOps.getAdapter();

		await seedRows(dbOps, 2000, 512);
		await adapter.run(`DELETE FROM requests`, []);
		await adapter.run(`PRAGMA wal_checkpoint(TRUNCATE)`, []);

		const freeBefore = dbOps.getFreelistCount();
		expect(freeBefore).toBeGreaterThan(0);

		// Cap reclaim at 32 pages with 16-page chunks → at most ceil(32/16)=2
		// chunks should run.
		const r = await dbOps.incrementalVacuumAdaptive({
			chunkPages: 16,
			maxPagesPerTick: 32,
		});

		expect(r.chunks).toBeLessThanOrEqual(2);
		// Freelist still has pages left because the per-tick budget was small.
		expect(dbOps.getFreelistCount()).toBeGreaterThan(0);
	});

	// The tests below drive incrementalVacuumAdaptive() with a faked
	// incrementalVacuum()/getFreelistCount() pair instead of the real Worker,
	// mirroring the disable-marker hotfix's test style (docs/operations/
	// 2026-09-08-disable-auto-vacuum.patch). The three tests above already
	// exercise the real worker end-to-end and are slow/flaky in constrained
	// CI/sandboxed environments (observed timing out past the 5s per-test
	// default on this machine, pre-existing and unrelated to this change);
	// fakes keep the new coverage fast and deterministic without touching
	// that pre-existing behavior.
	it("opts.enabled=false skips before the freelist read, does not spawn a worker, and updates VacuumStatus", async () => {
		const internals = dbOps as unknown as {
			getFreelistCount: () => number;
			incrementalVacuum: (pages: number) => Promise<void>;
		};
		let freelistReads = 0;
		let vacuumCalls = 0;
		internals.getFreelistCount = () => {
			freelistReads += 1;
			return 100;
		};
		internals.incrementalVacuum = async () => {
			vacuumCalls += 1;
		};

		const before = Date.now();
		const r = await dbOps.incrementalVacuumAdaptive({ enabled: false });

		expect(r).toEqual({ reclaimedPages: 0, chunks: 0 });
		expect(freelistReads).toBe(0);
		expect(vacuumCalls).toBe(0);

		const status = dbOps.getVacuumStatus();
		expect(status.enabled).toBe(false);
		expect(status.lastRunAt).not.toBeNull();
		expect(status.lastRunAt as number).toBeGreaterThanOrEqual(before);
		// Disabled path must not touch freelist/ratio fields — they stay at
		// whatever they were (the freshly-constructed default here).
		expect(status.freelistPages).toBe(0);
		expect(status.lastReclaimedPages).toBe(0);
		expect(status.lastChunks).toBe(0);
	});

	it("opts.enabled defaults to true (omitted) — unchanged from before the switch existed", async () => {
		const internals = dbOps as unknown as {
			getFreelistCount: () => number;
			incrementalVacuum: (pages: number) => Promise<void>;
		};
		let freelist = 10;
		internals.getFreelistCount = () => freelist;
		internals.incrementalVacuum = async (pages: number) => {
			freelist = Math.max(0, freelist - pages);
		};

		const r = await dbOps.incrementalVacuumAdaptive({
			chunkPages: 10,
			maxPagesPerTick: 10,
		});

		expect(r).toEqual({ reclaimedPages: 10, chunks: 1 });
		expect(dbOps.getVacuumStatus().enabled).toBe(true);
	});

	it("records reclaimedPages, chunks and the freelist ratio in VacuumStatus after a reclaim", async () => {
		const internals = dbOps as unknown as {
			getFreelistCount: () => number;
			getPageCount: () => number;
			incrementalVacuum: (pages: number) => Promise<void>;
		};
		let freelist = 40;
		internals.getFreelistCount = () => freelist;
		internals.getPageCount = () => 200; // freelist starts at 40/200 = 20%
		internals.incrementalVacuum = async (pages: number) => {
			freelist = Math.max(0, freelist - pages);
		};

		const r = await dbOps.incrementalVacuumAdaptive({
			chunkPages: 10,
			maxPagesPerTick: 40,
		});

		expect(r).toEqual({ reclaimedPages: 40, chunks: 4 });
		const status = dbOps.getVacuumStatus();
		expect(status.lastReclaimedPages).toBe(40);
		expect(status.lastChunks).toBe(4);
		expect(status.freelistPages).toBe(0);
		// Freelist fully drained (0/200) after the reclaim.
		expect(status.freelistRatio).toBe(0);
		expect(status.consecutiveBusySkips).toBe(0);
		expect(status.escalated).toBe(false);
	});

	it("records a steady-state no-op (empty freelist) in VacuumStatus without spawning a worker", async () => {
		const internals = dbOps as unknown as {
			getFreelistCount: () => number;
			incrementalVacuum: (pages: number) => Promise<void>;
		};
		internals.getFreelistCount = () => 0;
		let vacuumCalls = 0;
		internals.incrementalVacuum = async () => {
			vacuumCalls += 1;
		};

		const r = await dbOps.incrementalVacuumAdaptive();

		expect(r).toEqual({ reclaimedPages: 0, chunks: 0 });
		expect(vacuumCalls).toBe(0);
		const status = dbOps.getVacuumStatus();
		expect(status.enabled).toBe(true);
		expect(status.lastRunAt).not.toBeNull();
		expect(status.lastReclaimedPages).toBe(0);
		expect(status.lastChunks).toBe(0);
	});
});

describe("DatabaseOperations.getPageCount", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(async () => {
		await dbOps.dispose?.();
	});

	it("returns a positive integer on a fresh DB (schema pages already allocated)", () => {
		const n = dbOps.getPageCount();
		expect(typeof n).toBe("number");
		expect(n).toBeGreaterThan(0);
		expect(Number.isInteger(n)).toBe(true);
	});
});

// internal-4: incrementalVacuumAdaptive() previously returned before ever
// touching vacuumStatus when this.sqliteDb/this.resolvedDbPath is absent
// (PostgreSQL, or a defensive "no handle open" case), so /health kept
// reporting the SQLite-shaped default (enabled: true, lastRunAt: null)
// forever — contradicting both the "no-op on PostgreSQL" documentation and
// an operator dead-man alert built on lastRunAt. No live PostgreSQL server
// is available in this dev/CI environment (see migrations-pg.test.ts), so
// this simulates the guard's condition directly on an otherwise-real SQLite
// instance rather than constructing a real PG-mode DatabaseOperations.
describe("DatabaseOperations.incrementalVacuumAdaptive — unsupported backend (internal-4)", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(async () => {
		await dbOps.dispose?.();
	});

	it("reports supported: false and enabled: false, and never runs a reclaim, when no SQLite handle is open", async () => {
		const internals = dbOps as unknown as {
			sqliteDb: unknown;
			resolvedDbPath: unknown;
			incrementalVacuum: (pages: number) => Promise<void>;
		};
		internals.sqliteDb = undefined;
		internals.resolvedDbPath = undefined;
		let vacuumCalls = 0;
		internals.incrementalVacuum = async () => {
			vacuumCalls += 1;
		};

		const r = await dbOps.incrementalVacuumAdaptive();

		expect(r).toEqual({ reclaimedPages: 0, chunks: 0 });
		expect(vacuumCalls).toBe(0);
		const status = dbOps.getVacuumStatus();
		expect(status.supported).toBe(false);
		expect(status.enabled).toBe(false);
	});
});

// internal-4: a rejected incrementalVacuum() chunk previously propagated
// straight out of incrementalVacuumAdaptive() without ever recording
// anything — lastRunAt silently froze at the last successful tick, and the
// failure was visible only in logs.
describe("DatabaseOperations.incrementalVacuumAdaptive — records a rejected reclaim (internal-4)", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(async () => {
		await dbOps.dispose?.();
	});

	it("records lastError (message only) and lastRunAt, and still propagates the rejection", async () => {
		const internals = dbOps as unknown as {
			getFreelistCount: () => number;
			incrementalVacuum: (pages: number) => Promise<void>;
		};
		internals.getFreelistCount = () => 100; // non-empty, so the loop runs
		internals.incrementalVacuum = async () => {
			throw new Error("incremental-vacuum worker timed out after 120000ms");
		};

		const before = Date.now();
		await expect(dbOps.incrementalVacuumAdaptive()).rejects.toThrow(
			"incremental-vacuum worker timed out after 120000ms",
		);

		const status = dbOps.getVacuumStatus();
		expect(status.lastError).toBe(
			"incremental-vacuum worker timed out after 120000ms",
		);
		expect(status.lastRunAt).not.toBeNull();
		expect(status.lastRunAt as number).toBeGreaterThanOrEqual(before);
	});

	it("clears lastError on the next call that completes without throwing", async () => {
		const internals = dbOps as unknown as {
			getFreelistCount: () => number;
			incrementalVacuum: (pages: number) => Promise<void>;
		};
		internals.getFreelistCount = () => 100;
		internals.incrementalVacuum = async () => {
			throw new Error("boom");
		};
		await expect(dbOps.incrementalVacuumAdaptive()).rejects.toThrow("boom");
		expect(dbOps.getVacuumStatus().lastError).toBe("boom");

		// Now let it succeed (steady-state no-op).
		internals.getFreelistCount = () => 0;
		await dbOps.incrementalVacuumAdaptive();
		expect(dbOps.getVacuumStatus().lastError).toBeNull();
	});
});

// internal-2: the catch-up tick's own backoff (the async DB writer's queue
// non-empty) happens before incrementalVacuumAdaptive() is ever called, so
// these two counters are updated directly by the scheduler rather than
// through recordVacuumStatus().
describe("DatabaseOperations.recordVacuumCatchUpBusySkip / resetVacuumCatchUpBusySkips", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(async () => {
		await dbOps.dispose?.();
	});

	it("increments both counters and returns the updated consecutive count", () => {
		expect(dbOps.recordVacuumCatchUpBusySkip()).toBe(1);
		expect(dbOps.recordVacuumCatchUpBusySkip()).toBe(2);
		expect(dbOps.recordVacuumCatchUpBusySkip()).toBe(3);

		const status = dbOps.getVacuumStatus();
		expect(status.catchUpBusySkips).toBe(3);
		expect(status.catchUpBusySkipsTotal).toBe(3);
	});

	it("resetVacuumCatchUpBusySkips clears only the consecutive counter, never the lifetime total", () => {
		dbOps.recordVacuumCatchUpBusySkip();
		dbOps.recordVacuumCatchUpBusySkip();
		dbOps.resetVacuumCatchUpBusySkips();

		const status = dbOps.getVacuumStatus();
		expect(status.catchUpBusySkips).toBe(0);
		expect(status.catchUpBusySkipsTotal).toBe(2);
	});

	it("a successful incrementalVacuumAdaptive() call does not clobber an in-progress busy-skip streak", async () => {
		const internals = dbOps as unknown as {
			getFreelistCount: () => number;
			incrementalVacuum: (pages: number) => Promise<void>;
		};
		internals.getFreelistCount = () => 0; // steady-state no-op path
		internals.incrementalVacuum = async () => {};

		dbOps.recordVacuumCatchUpBusySkip();
		dbOps.recordVacuumCatchUpBusySkip();

		await dbOps.incrementalVacuumAdaptive();

		const status = dbOps.getVacuumStatus();
		expect(status.catchUpBusySkips).toBe(2);
		expect(status.catchUpBusySkipsTotal).toBe(2);
	});
});

// internal-3: the awaited worker promise in incrementalVacuum() previously
// had no timer — resolve on onmessage, reject on onerror, and nothing else.
// A worker that dies without delivering either left the await pending
// forever, which (once vacuum-scheduler.ts's shared vacuumTickInFlight guard
// exists) permanently disables both reclaim ticks. These tests fake the
// global Worker constructor so a "hung worker" never posts a message,
// without spawning a real thread or sleeping for the real 120s default.
describe("DatabaseOperations.incrementalVacuum — worker timeout (internal-3)", () => {
	let dbOps: DatabaseOperations;
	let OriginalWorker: typeof Worker;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
		OriginalWorker = globalThis.Worker;
	});

	afterEach(async () => {
		globalThis.Worker = OriginalWorker;
		await dbOps.dispose?.();
	});

	it("rejects with a descriptive Error, and still terminates the worker, when it never posts onmessage or onerror", async () => {
		let terminated = false;
		class HangingWorker {
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: ErrorEvent) => void) | null = null;
			constructor(
				public url: string | URL,
				public opts?: unknown,
			) {}
			postMessage(_msg: unknown): void {
				// Deliberately never calls onmessage or onerror — simulates a
				// worker that died without delivering either callback.
			}
			terminate(): void {
				terminated = true;
			}
		}
		// @ts-expect-error test double — only implements what incrementalVacuum() uses
		globalThis.Worker = HangingWorker;

		await expect(
			dbOps.incrementalVacuum(100, { workerTimeoutMs: 20 }),
		).rejects.toThrow(/timed out/);
		expect(terminated).toBe(true);
	});
});
