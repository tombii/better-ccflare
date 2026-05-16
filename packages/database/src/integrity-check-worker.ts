import { Database } from "bun:sqlite";

/**
 * Dedicated worker for running integrity checks against the SQLite file
 * out-of-band. `bun:sqlite` is synchronous, so any pragma that scans the
 * whole DB blocks the JS event loop for its full duration. On a multi-GB
 * DB even `PRAGMA quick_check` takes tens of seconds, which would freeze
 * the proxy (no incoming connections accepted, no streaming writes
 * flushed, downstream sockets reset).
 *
 * The worker opens its own `bun:sqlite` `Database` against the same file
 * with `readonly: true` — SQLite's WAL mode supports concurrent readers
 * alongside the main-thread writer without lock contention — runs the
 * requested pragmas, and posts the combined result back.
 *
 * Two kinds:
 *  - `"quick"`: `PRAGMA quick_check` only. Catches page-structure /
 *    freelist issues fast; runs every few hours.
 *  - `"full"`: `PRAGMA integrity_check` + `PRAGMA foreign_key_check`.
 *    `integrity_check` covers B-tree consistency, index/table
 *    cross-checks, UNIQUE/CHECK/NOT NULL, freelist — but does NOT check
 *    foreign keys (per SQLite docs). `foreign_key_check` returns one row
 *    per violation. Together they reproduce the safety net the startup
 *    check used to provide. Runs daily.
 */

export type IntegrityCheckKind = "quick" | "full";

export type IntegrityCheckRequest = {
	dbPath: string;
	busyTimeoutMs: number;
	kind: IntegrityCheckKind;
};

export type IntegrityCheckResult = { ok: true } | { ok: false; error: string };

self.onmessage = (event: MessageEvent<IntegrityCheckRequest>) => {
	const { dbPath, busyTimeoutMs, kind } = event.data;
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		db.exec(
			`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(Number(busyTimeoutMs) || 10000))}`,
		);

		if (kind === "quick") {
			// quick_check returns a single row: "ok" or a problem description.
			const row = db.query("PRAGMA quick_check").get() as {
				quick_check: string;
			};
			const msg = row.quick_check;
			db.close();
			db = undefined;
			if (msg === "ok") {
				self.postMessage({ ok: true } satisfies IntegrityCheckResult);
			} else {
				self.postMessage({
					ok: false,
					error: msg,
				} satisfies IntegrityCheckResult);
			}
			return;
		}

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
