/**
 * Real on-disk SQLite DBs for tests, with guaranteed cleanup.
 *
 * `DatabaseOperations.dispose()` closes the handle but never unlinks the file,
 * so tests that only dispose accumulate `<prefix>-<hex>.db` (+ `-wal`/`-shm`)
 * siblings in `$TMPDIR` forever. Every path handed out by `tempDbPath()` is
 * tracked at module scope and removed by `cleanupTempDbs()`.
 *
 * Call `cleanupTempDbs()` from the suite's `afterAll`. Each test file runs in
 * its own module instance under `bun test`, so the tracked set never spans
 * files.
 */

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createdPaths = new Set<string>();

/**
 * Return a fresh `<tmpdir>/<prefix>-<hex>.db` path and register it (plus its
 * `-wal` / `-shm` siblings) for removal by `cleanupTempDbs()`.
 */
export function tempDbPath(prefix: string): string {
	const dbPath = join(
		tmpdir(),
		`${prefix}-${randomBytes(6).toString("hex")}.db`,
	);
	createdPaths.add(dbPath);
	return dbPath;
}

/**
 * Unlink every DB path handed out by `tempDbPath()` along with its SQLite
 * `-wal` / `-shm` siblings. Best-effort: missing files are ignored.
 */
export function cleanupTempDbs(): void {
	for (const dbPath of createdPaths) {
		for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
			try {
				rmSync(p, { force: true });
			} catch {
				// Ignore cleanup errors — a leaked file must not fail the suite.
			}
		}
	}
	createdPaths.clear();
}
