import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLegacyDbPath, resolveDbPath } from "./paths";

/**
 * Whether the operator chose the database path explicitly, rather than the
 * path being derived from the platform config directory.
 */
function hasExplicitDbPath(): boolean {
	return Boolean(
		process.env.BETTER_CCFLARE_DB_PATH || process.env.ccflare_DB_PATH,
	);
}

/**
 * Migrate from legacy ccflare database to better-ccflare
 * This function:
 * 1. Skips entirely when a database path is set explicitly
 * 2. Checks if better-ccflare.db exists (if yes, no migration needed)
 * 3. Checks if legacy ccflare.db exists
 * 4. Copies ccflare.db and related files to better-ccflare.db location
 *
 * @returns true if migration was performed, false otherwise
 */
export function migrateFromCcflare(): boolean {
	// An explicit `BETTER_CCFLARE_DB_PATH` is a deliberate choice of database
	// — an isolated test instance, a container, a new deployment. Copying a
	// legacy database (accounts and their stored tokens included) into it is
	// never what the caller asked for, so honour the choice and do nothing.
	// The absence of the target file is the *trigger* for a default install,
	// not a licence to import into any path.
	if (hasExplicitDbPath()) {
		return false;
	}

	const newDbPath = resolveDbPath();
	const legacyDbPath = getLegacyDbPath();

	// If new DB already exists, no migration needed
	if (existsSync(newDbPath)) {
		return false;
	}

	// If legacy DB doesn't exist, no migration possible
	if (!existsSync(legacyDbPath)) {
		return false;
	}

	try {
		// Ensure target directory exists
		const newDbDir = dirname(newDbPath);
		if (!existsSync(newDbDir)) {
			mkdirSync(newDbDir, { recursive: true });
		}

		// Copy main database file
		copyFileSync(legacyDbPath, newDbPath);
		console.log(`✅ Migrated database from ${legacyDbPath} to ${newDbPath}`);

		// Copy WAL and SHM files if they exist
		const walPath = `${legacyDbPath}-wal`;
		const shmPath = `${legacyDbPath}-shm`;

		if (existsSync(walPath)) {
			copyFileSync(walPath, `${newDbPath}-wal`);
			console.log(`✅ Migrated WAL file`);
		}

		if (existsSync(shmPath)) {
			copyFileSync(shmPath, `${newDbPath}-shm`);
			console.log(`✅ Migrated SHM file`);
		}

		console.log(`
⚠️  Migration complete! Your ccflare data has been copied to better-ccflare.
   The original ccflare files have been left intact for safety.
   You can delete them manually if desired: ${dirname(legacyDbPath)}/
`);

		return true;
	} catch (error) {
		console.error(`❌ Failed to migrate database: ${error}`);
		return false;
	}
}
