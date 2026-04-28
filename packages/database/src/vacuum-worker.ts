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
