/**
 * Apply schema + migrations against the database in DATABASE_URL, then exit.
 *
 * There is no standalone migrate command in this repo: for PostgreSQL the
 * entire migration surface is DatabaseOperations.initializeAsync(), which calls
 * ensureSchemaPg() then runMigrationsPg(). Booting the full server would also
 * apply them, but drags in the proxy, API and dashboard for no reason and
 * leaves a process running.
 *
 * Used by the staging migration rehearsal so the migration can be applied as a
 * single foreground command with a real exit code.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun run scripts/apply-migrations.ts
 *
 * Exits non-zero if the migration throws, so a rehearsal harness can stop
 * before the rollback step and leave the broken state inspectable.
 */
import { DatabaseOperations } from "@better-ccflare/database";

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("DATABASE_URL is not set — refusing to run.");
	process.exit(2);
}
if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
	// Guard rather than silently falling through to the SQLite path, which
	// would create a local db file and report success having migrated nothing.
	console.error(
		"DATABASE_URL is not a postgres:// or postgresql:// URL — refusing to run.",
	);
	process.exit(2);
}

const dbOps = new DatabaseOperations();
try {
	await dbOps.initializeAsync();
	console.log("migrations applied");
	process.exit(0);
} catch (error) {
	console.error("migration failed:", error);
	process.exit(1);
}
