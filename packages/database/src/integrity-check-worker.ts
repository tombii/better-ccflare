import { Database } from "bun:sqlite";

/**
 * Dedicated worker for running the full integrity check on the SQLite file
 * out-of-band. `PRAGMA integrity_check` on a multi-GB DB can take tens of
 * seconds and `bun:sqlite` is synchronous (blocks the JS event loop), so
 * running it on the main thread would freeze the proxy for that duration.
 *
 * The worker opens its own `bun:sqlite` `Database` against the same file —
 * SQLite's WAL mode supports concurrent readers without conflict — runs the
 * pragmas, and posts the combined result back.
 *
 * Combines `PRAGMA integrity_check` and `PRAGMA foreign_key_check`:
 * `integrity_check` covers page structure, B-tree consistency, index/table
 * cross-checks, UNIQUE/CHECK/NOT NULL, freelist — but does NOT check
 * foreign keys (per SQLite docs). `foreign_key_check` returns one row per
 * violation. Together they reproduce the safety net the startup check used
 * to provide.
 */

export type IntegrityCheckRequest = {
	dbPath: string;
	busyTimeoutMs: number;
};

export type IntegrityCheckResult = { ok: true } | { ok: false; error: string };

self.onmessage = (event: MessageEvent<IntegrityCheckRequest>) => {
	const { dbPath, busyTimeoutMs } = event.data;
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		db.exec(
			`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(Number(busyTimeoutMs) || 10000))}`,
		);

		// integrity_check returns one row per problem, or a single "ok" row.
		const integrityRows = db.query("PRAGMA integrity_check").all() as Array<{
			integrity_check: string;
		}>;
		const integrityMsg = integrityRows.map((r) => r.integrity_check).join("\n");

		// foreign_key_check returns one row per violation; empty result = no
		// violations. Each row contains table/rowid/parent/fkid columns; we
		// stringify a sample for the error message.
		const fkRows = db.query("PRAGMA foreign_key_check").all() as Array<
			Record<string, unknown>
		>;

		db.close();
		db = undefined;

		const integrityOk = integrityMsg === "ok";
		const fkOk = fkRows.length === 0;
		if (integrityOk && fkOk) {
			self.postMessage({ ok: true } satisfies IntegrityCheckResult);
			return;
		}

		const parts: string[] = [];
		if (!integrityOk) parts.push(`integrity_check: ${integrityMsg}`);
		if (!fkOk) {
			parts.push(
				`foreign_key_check: ${fkRows.length} violation(s) — ${JSON.stringify(fkRows.slice(0, 5))}${fkRows.length > 5 ? " (truncated)" : ""}`,
			);
		}
		self.postMessage({
			ok: false,
			error: parts.join("\n"),
		} satisfies IntegrityCheckResult);
	} catch (err) {
		db?.close();
		self.postMessage({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		} satisfies IntegrityCheckResult);
	}
};
