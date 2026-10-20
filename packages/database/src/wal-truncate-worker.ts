import { Database } from "bun:sqlite";

/**
 * Dedicated worker for `PRAGMA wal_checkpoint(TRUNCATE)`.
 *
 * Why a worker, not the main `sqliteDb` handle:
 *   `bun:sqlite` is synchronous — every call blocks the JS event loop for
 *   its full duration. A TRUNCATE checkpoint copies every WAL frame back
 *   into the database file and then truncates the `-wal` file to zero
 *   bytes. On a database whose WAL grew while a long-lived reader (the
 *   integrity-check worker) held a read snapshot, that copy is tens or
 *   hundreds of megabytes: seconds of frozen event loop, during which the
 *   proxy accepts no connections, flushes no streaming writes, and gets
 *   its downstream sockets reset by the OS.
 *
 *   The main connection already runs `wal_checkpoint(PASSIVE)` every five
 *   minutes (see `DatabaseOperations.optimize()`), but that copy is bounded
 *   by `wal_autocheckpoint` (1000 pages), whereas a TRUNCATE checkpoint has
 *   to move whatever the WAL is holding. Keeping the checkpoint off-thread
 *   is the same trade-off the vacuum and integrity-check workers already
 *   make (see `vacuum-worker.ts` / `integrity-check-worker.ts`).
 *
 * Locking: the worker sets `busy_timeout = 0`, so a checkpoint that cannot
 * get the WAL (a reader holds a snapshot, another connection is
 * checkpointing, the file is exclusively locked) reports "busy" and returns
 * immediately instead of spinning. A busy result is harmless — the next
 * tick retries. Real errors (I/O, disk full, corrupt file) are reported
 * separately so the caller can log them above debug level.
 *
 * Memory knobs applied to the worker's own connection (it opens a separate
 * handle, so the main process's `configureSqlite` settings don't apply):
 *  - `cache_size = -2000` (2 MiB): the checkpoint streams pages; a big
 *    page cache buys nothing and counts against the cgroup.
 *  - `temp_store = FILE`: never spill temp tables to RAM.
 *  - `mmap_size = 0`: no mmap; reads go through the page cache.
 */

export type WalTruncateRequest = {
	dbPath: string;
	/**
	 * `busy_timeout` for the worker's connection. `0` (the default) makes
	 * the checkpoint give up at once when the WAL is held by someone else.
	 */
	busyTimeoutMs?: number;
	/**
	 * `PRAGMA journal_size_limit` for the worker's connection, so a WAL
	 * reset performed by this connection is trimmed the same way the main
	 * connection's is. `undefined` leaves SQLite's default (no limit).
	 */
	journalSizeLimitBytes?: number;
};

export type WalTruncateResponse =
	| {
			ok: true;
			/** 1 when the checkpoint could not complete (WAL held by someone else). */
			busy: number;
			/** Size of the WAL in pages at the time of the checkpoint. */
			log: number;
			/** Number of frames copied back into the database file. */
			checkpointed: number;
	  }
	| {
			ok: false;
			error: string;
			/** True when the failure was lock contention rather than a real error. */
			busy: boolean;
	  };

/**
 * True for SQLITE_BUSY / SQLITE_LOCKED, false for everything else (I/O
 * errors, disk full, corruption). Bun exposes the SQLite result code as
 * `err.code`; the message check is a fallback for errors that don't carry
 * one.
 */
function isBusyError(err: unknown): boolean {
	const code = (err as { code?: unknown })?.code;
	if (typeof code === "string") {
		if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
		if (code.startsWith("SQLITE_BUSY_") || code.startsWith("SQLITE_LOCKED_")) {
			return true;
		}
	}
	const message = err instanceof Error ? err.message : String(err);
	return /database is locked|database table is locked|locking protocol/i.test(
		message,
	);
}

self.onmessage = (event: MessageEvent<WalTruncateRequest>) => {
	const { dbPath, busyTimeoutMs, journalSizeLimitBytes } = event.data;
	let db: Database | undefined;
	try {
		// `readwrite: true` is required for a TRUNCATE checkpoint (it writes
		// to the database file and resets the WAL); `create: false` makes sure
		// a vanished database file is an error instead of a stray empty DB.
		// Note: bun:sqlite rejects an options object without an explicit
		// `readwrite`/`readonly` flag, so both are spelled out here.
		db = new Database(dbPath, { readwrite: true, create: false });
		db.exec("PRAGMA mmap_size = 0");
		db.exec("PRAGMA cache_size = -2000");
		db.exec("PRAGMA temp_store = FILE");
		const timeout = Math.max(0, Math.trunc(Number(busyTimeoutMs) || 0));
		db.exec(`PRAGMA busy_timeout = ${timeout}`);
		if (
			journalSizeLimitBytes !== undefined &&
			Number.isFinite(journalSizeLimitBytes)
		) {
			db.exec(
				`PRAGMA journal_size_limit = ${Math.max(0, Math.trunc(journalSizeLimitBytes))}`,
			);
		}

		const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
			busy: number;
			log: number;
			checkpointed: number;
		} | null;

		db.close();
		db = undefined;

		self.postMessage({
			ok: true,
			busy: row?.busy ?? 0,
			log: row?.log ?? -1,
			checkpointed: row?.checkpointed ?? -1,
		} satisfies WalTruncateResponse);
	} catch (err) {
		db?.close();
		self.postMessage({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			busy: isBusyError(err),
		} satisfies WalTruncateResponse);
	}
};
