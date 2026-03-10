import type { DatabaseOperations } from "@better-ccflare/database";

interface RepairResult {
	integrityOk: boolean;
	nullsFixed: number;
	vacuumed: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Perform database integrity check and repair
 */
export async function repairDatabase(
	dbOps: DatabaseOperations,
): Promise<RepairResult> {
	const result: RepairResult = {
		integrityOk: false,
		nullsFixed: 0,
		vacuumed: false,
		errors: [],
		warnings: [],
	};

	const adapter = dbOps.getAdapter();

	console.log("Checking database integrity...\n");

	// 1. Check database integrity (SQLite only - PostgreSQL uses different mechanisms)
	if (dbOps.isSQLite) {
		try {
			const integrityResult = await adapter.get<{
				integrity_check: string;
			}>("PRAGMA integrity_check");

			if (integrityResult?.integrity_check === "ok") {
				result.integrityOk = true;
				console.log("Database integrity check: PASSED\n");
			} else {
				result.integrityOk = false;
				result.errors.push(
					`Integrity check failed: ${integrityResult?.integrity_check}`,
				);
				console.log(
					`Database integrity check: FAILED\n   ${integrityResult?.integrity_check}\n`,
				);
			}
		} catch (error) {
			result.errors.push(`Failed to run integrity check: ${error}`);
			console.log(`Failed to run integrity check: ${error}\n`);
			return result;
		}
	} else {
		// PostgreSQL - assume integrity is ok (managed by PostgreSQL itself)
		result.integrityOk = true;
		console.log(
			"Database integrity check: SKIPPED (PostgreSQL manages integrity internally)\n",
		);
	}

	// 2. Check for NULL values in numeric fields
	console.log("Checking for NULL values in account fields...\n");
	try {
		const nullCheckQuery = `
			SELECT
				COUNT(*) as total,
				SUM(CASE WHEN request_count IS NULL THEN 1 ELSE 0 END) as null_request_count,
				SUM(CASE WHEN total_requests IS NULL THEN 1 ELSE 0 END) as null_total_requests,
				SUM(CASE WHEN session_request_count IS NULL THEN 1 ELSE 0 END) as null_session_count
			FROM accounts
		`;

		const nullStats = await adapter.get<{
			total: number;
			null_request_count: number;
			null_total_requests: number;
			null_session_count: number;
		}>(nullCheckQuery);

		const totalNulls = nullStats
			? Number(nullStats.null_request_count) +
				Number(nullStats.null_total_requests) +
				Number(nullStats.null_session_count)
			: 0;

		if (totalNulls > 0) {
			result.warnings.push(
				`Found ${totalNulls} NULL values in account numeric fields`,
			);
			console.log(`Found NULL values in account fields:`);
			console.log(`   - request_count: ${nullStats?.null_request_count}`);
			console.log(`   - total_requests: ${nullStats?.null_total_requests}`);
			console.log(
				`   - session_request_count: ${nullStats?.null_session_count}`,
			);
			console.log("");

			// Fix NULL values
			console.log("Fixing NULL values...\n");
			const changesCount = await adapter.runWithChanges(`
				UPDATE accounts
				SET
					request_count = COALESCE(request_count, 0),
					total_requests = COALESCE(total_requests, 0),
					session_request_count = COALESCE(session_request_count, 0)
				WHERE
					request_count IS NULL
					OR total_requests IS NULL
					OR session_request_count IS NULL
			`);

			result.nullsFixed = changesCount;
			console.log(
				`Fixed ${result.nullsFixed} account records with NULL values\n`,
			);
		} else {
			console.log("No NULL values found in account fields\n");
		}
	} catch (error) {
		result.errors.push(`Failed to check/fix NULL values: ${error}`);
		console.log(`Failed to check/fix NULL values: ${error}\n`);
	}

	// 3. Check foreign key constraints (SQLite only)
	if (dbOps.isSQLite) {
		console.log("Checking foreign key constraints...\n");
		try {
			const fkCheck = await adapter.query("PRAGMA foreign_key_check");
			if (fkCheck.length === 0) {
				console.log("Foreign key constraints: PASSED\n");
			} else {
				result.warnings.push(`Found ${fkCheck.length} foreign key violations`);
				console.log(`Found ${fkCheck.length} foreign key violations:`);
				for (const violation of fkCheck) {
					console.log(`   ${JSON.stringify(violation)}`);
				}
				console.log("");
			}
		} catch (error) {
			result.warnings.push(`Failed to check foreign keys: ${error}`);
			console.log(`Failed to check foreign keys: ${error}\n`);
		}

		// 4. Vacuum database to rebuild and optimize (SQLite only)
		console.log("Vacuuming database (this may take a moment)...\n");
		try {
			await adapter.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
			await adapter.unsafe("VACUUM");
			result.vacuumed = true;
			console.log("Database vacuumed successfully\n");
		} catch (error) {
			result.errors.push(`Failed to vacuum database: ${error}`);
			console.log(`Failed to vacuum database: ${error}\n`);
		}

		// 5. Optimize database (SQLite only)
		console.log("Optimizing database...\n");
		try {
			await adapter.unsafe("ANALYZE");
			await adapter.unsafe("PRAGMA optimize");
			console.log("Database optimized successfully\n");
		} catch (error) {
			result.warnings.push(`Failed to optimize database: ${error}`);
			console.log(`Failed to optimize database: ${error}\n`);
		}
	} else {
		// PostgreSQL
		result.vacuumed = true; // PostgreSQL autovacuums
		console.log(
			"Vacuum/optimize: SKIPPED (PostgreSQL handles this automatically via autovacuum)\n",
		);
	}

	return result;
}

/**
 * Print summary of repair results
 */
export function printRepairSummary(result: RepairResult): void {
	console.log("=".repeat(50));
	console.log("DATABASE REPAIR SUMMARY");
	console.log("=".repeat(50));
	console.log("");

	console.log("Results:");
	console.log(
		`   Integrity Check: ${result.integrityOk ? "PASSED" : "FAILED"}`,
	);
	console.log(`   NULL Values Fixed: ${result.nullsFixed}`);
	console.log(`   Database Vacuumed: ${result.vacuumed ? "YES" : "NO"}`);
	console.log("");

	if (result.errors.length > 0) {
		console.log("Errors:");
		for (const error of result.errors) {
			console.log(`   - ${error}`);
		}
		console.log("");
	}

	if (result.warnings.length > 0) {
		console.log("Warnings:");
		for (const warning of result.warnings) {
			console.log(`   - ${warning}`);
		}
		console.log("");
	}

	if (result.integrityOk && result.errors.length === 0) {
		console.log("Database is healthy!");
	} else if (result.errors.length > 0) {
		console.log("Database has errors that may require manual intervention.");
		console.log(
			"   Consider backing up and recreating the database if issues persist.",
		);
	}
	console.log("");
}

/**
 * Main repair command handler
 */
export async function handleRepairCommand(
	dbOps: DatabaseOperations,
): Promise<void> {
	console.log("");
	console.log("BETTER-CCFLARE DATABASE REPAIR");
	console.log("=".repeat(50));
	console.log("");

	const result = await repairDatabase(dbOps);
	printRepairSummary(result);

	// Exit with appropriate code
	if (result.errors.length > 0) {
		process.exit(1);
	}
}
