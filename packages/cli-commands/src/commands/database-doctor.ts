import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

export async function runDoctor(
	dbOps: DatabaseOperations,
	options: { full?: boolean; recover?: boolean } = {},
): Promise<void> {
	const logger = new Logger("Doctor");

	console.log("\n🏥 better-ccflare doctor");
	console.log("═".repeat(50));

	// Integrity check
	console.log("\n📊 Integrity Check:");
	try {
		const checkResult = options.full
			? await dbOps.runFullIntegrityCheck()
			: await dbOps.runQuickIntegrityCheck();

		if (checkResult === "ok") {
			console.log("✅ Status: OK");
			logger.info("Integrity check passed");
		} else {
			console.log("❌ Status: CORRUPT");
			console.log(`Error: ${checkResult}`);
			logger.error(`Integrity check failed: ${checkResult}`);

			// Exit non-zero on corruption
			process.exitCode = 1;
		}
	} catch (error) {
		console.log(`❌ Check failed: ${error}`);
		logger.error(`Integrity check error: ${error}`);
		process.exitCode = 1;
	}

	// Storage metrics
	console.log("\n💾 Storage Metrics:");
	const metrics = await dbOps.getStorageMetrics();
	console.log(`DB Size: ${(metrics.dbBytes / 1024 / 1024).toFixed(2)} MB`);
	console.log(`WAL Size: ${(metrics.walBytes / 1024 / 1024).toFixed(2)} MB`);
	console.log(`Orphan Pages: ${metrics.orphanPages}`);
	console.log(
		`Last Retention Sweep: ${
			metrics.lastRetentionSweepAt
				? new Date(metrics.lastRetentionSweepAt).toISOString()
				: "never"
		}`,
	);
	console.log(`NULL Account Rows (24h): ${metrics.nullAccountRows}`);

	// Table counts
	console.log("\n📋 Table Counts:");
	const tables = await dbOps.getTableRowCounts();
	for (const table of tables.slice(0, 5)) {
		const bytes = table.dataBytes
			? ` (${(table.dataBytes / 1024 / 1024).toFixed(2)} MB)`
			: "";
		console.log(`  ${table.name}: ${table.rowCount} rows${bytes}`);
	}

	// Recovery instructions
	if (options.recover || process.exitCode === 1) {
		console.log("\n🔧 Recovery Instructions:");
		const instructions = await dbOps.generateRecoveryInstructions();
		console.log(instructions);
	}

	console.log("═".repeat(50));

	if (process.exitCode === 1) {
		console.log("\n❌ Doctor found issues. Review output above.");
	} else {
		console.log("\n✅ Doctor check complete. No issues found.");
	}
}
