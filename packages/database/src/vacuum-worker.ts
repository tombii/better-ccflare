import { Database } from "bun:sqlite";

type VacuumRequest = {
	dbPath: string;
	busyTimeoutMs: number;
};

type VacuumResult =
	| {
			ok: true;
			walBusy: number;
			walLog: number;
			walCheckpointed: number;
			walTruncateBusy?: number;
	  }
	| {
			ok: false;
			error: string;
			walBusy?: number;
			walLog?: number;
			walCheckpointed?: number;
			walTruncateBusy?: number;
	  };

self.onmessage = (event: MessageEvent<VacuumRequest>) => {
	const { dbPath, busyTimeoutMs } = event.data;
	let walBusy = 0;
	let walLog = 0;
	let walCheckpointed = 0;
	let walTruncateBusy: number | undefined;

	let db: Database | undefined;
	try {
		db = new Database(dbPath);
		// Apply memory-bounded PRAGMAs BEFORE anything else. The worker opens
		// its own connection here, so the main process's `configureSqlite`
		// PRAGMAs do not apply — without these the connection inherits
		// bun:sqlite's built-in defaults, which memory-map essentially the
		// entire DB file (~15 GiB observed on a 15 GiB DB). VACUUM then
		// walks every page, the resident set explodes, and the cgroup
		// OOM-kills the process. This is the same trap that motivated #231
		// for the main connection; the worker needs the same treatment.
		// (Greptile #231)
		//   - mmap_size = 0  : disable memory-mapped I/O entirely
		//   - cache_size = -2000 : cap page cache at 2 MiB (VACUUM doesn't
		//     benefit from a big cache; it streams pages)
		//   - temp_store = FILE : never spill VACUUM temp tables to RAM
		db.exec("PRAGMA mmap_size = 0");
		db.exec("PRAGMA cache_size = -2000");
		db.exec("PRAGMA temp_store = FILE");
		db.exec(
			`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(Number(busyTimeoutMs) || 10000))}`,
		);
		db.exec("PRAGMA journal_mode = WAL");

		const ckpt = db.query("PRAGMA wal_checkpoint(RESTART)").get() as {
			busy: number;
			log: number;
			checkpointed: number;
		} | null;

		if (ckpt) {
			walBusy = ckpt.busy;
			walLog = ckpt.log;
			walCheckpointed = ckpt.checkpointed;
			if (ckpt.busy > 0) {
				console.warn(
					`[vacuum-worker] WAL checkpoint: ${ckpt.busy} busy reader(s), ` +
						`${ckpt.checkpointed}/${ckpt.log} frames checkpointed. ` +
						"VACUUM will still run but WAL may not fully shrink.",
				);
			}
		}

		db.exec("VACUUM");

		const truncCkpt = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
			busy: number;
			log: number;
			checkpointed: number;
		} | null;

		if (truncCkpt) {
			walTruncateBusy = truncCkpt.busy;
			if (truncCkpt.busy > 0) {
				console.warn(
					`[vacuum-worker] TRUNCATE checkpoint: ${truncCkpt.busy} busy reader(s) — WAL file may not be zeroed.`,
				);
			}
		}

		db.close();
		db = undefined;

		self.postMessage({
			ok: true,
			walBusy,
			walLog,
			walCheckpointed,
			walTruncateBusy,
		} satisfies VacuumResult);
	} catch (err) {
		db?.close();
		self.postMessage({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			walBusy,
			walLog,
			walCheckpointed,
			walTruncateBusy,
		} satisfies VacuumResult);
	}
};
