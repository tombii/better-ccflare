import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLegacyDbPath, resolveDbPath } from "./paths";

/**
 * Migrate from legacy ccflare database to better-ccflare
 * This function:
 * 1. Checks if better-ccflare.db exists (if yes, no migration needed)
 * 2. Checks if legacy ccflare.db exists
 * 3. Copies ccflare.db and related files to better-ccflare.db location
 *
 * @returns true if migration was performed, false otherwise
 */
export function migrateFromCcflare(): boolean {
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
