import { Database } from "bun:sqlite";

/**
 * Dedicated worker for `PRAGMA incremental_vacuum(N)`.
 *
 * Why a worker, not the main `sqliteDb` handle:
 *   `bun:sqlite` is synchronous (blocks the JS event loop for the duration of
 *   any call). `PRAGMA incremental_vacuum(N)` is a write transaction that
 *   moves up to N free pages back to the OS. For our hourly hourly retention
 *   tick (N≈8000, ~32 MiB) the operation is usually fast on local SSD, but
 *   under load or on a fragmented file it can climb into hundreds of
 *   milliseconds. Off-thread keeps the proxy's HTTP loop responsive.
 *
 * Locking: this still takes SQLite's single writer slot, so any concurrent
 * write from main or post-processor connections will wait on `busy_timeout`
 * until this finishes. That's expected and bounded by the chunk size we pass
 * in (small N → short hold).
 *
 * Memory knobs applied inside the worker connection:
 *  - `cache_size = -2000` (2 MiB): keep SQLite's page cache small; the worker
 *    is short-lived and doesn't need a big cache for one PRAGMA.
 *  - `temp_store = FILE`: never spill temp tables to RAM under cgroup pressure.
 *  - `mmap_size = 0`: no mmap; reads go through the page cache (still
 *    reclaimable by the kernel under MemoryHigh pressure).
 *  - `busy_timeout = 0`: fail fast instead of sleeping in C. The caller
 *    handles a SQLITE_BUSY by retrying on the next hourly tick.
 *
 * Refuses if `auto_vacuum != 2` — the operation is a no-op there and would
 * mask a misconfigured DB. Callers should have gated already via the same
 * check on the main connection, but the worker double-checks since it
 * opens its own handle.
 */

export type IncrementalVacuumRequest = {
	dbPath: string;
	pages: number;
};

export type IncrementalVacuumResult =
	| { ok: true; mode: number }
	| { ok: false; error: string };

self.onmessage = (event: MessageEvent<IncrementalVacuumRequest>) => {
	const { dbPath, pages } = event.data;
	let db: Database | undefined;
	try {
		db = new Database(dbPath);
		db.exec("PRAGMA busy_timeout = 0");
		db.exec("PRAGMA cache_size = -2000");
		db.exec("PRAGMA temp_store = FILE");
		db.exec("PRAGMA mmap_size = 0");

		const mode = (
			db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
		).auto_vacuum;
		if (mode !== 2) {
			db.close();
			self.postMessage({
				ok: false,
				error: `auto_vacuum=${mode}; expected 2 (INCREMENTAL). Run startup bootstrap migration first.`,
			} satisfies IncrementalVacuumResult);
			return;
		}

		const n = Math.max(1, Math.trunc(Number(pages) || 1));
		db.exec(`PRAGMA incremental_vacuum(${n})`);

		db.close();
		db = undefined;
		self.postMessage({ ok: true, mode } satisfies IncrementalVacuumResult);
	} catch (err) {
		db?.close();
		self.postMessage({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		} satisfies IncrementalVacuumResult);
	}
};
