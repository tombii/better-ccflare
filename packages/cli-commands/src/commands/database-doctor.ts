import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

export async function runDoctor(
	dbOps: DatabaseOperations,
	options: { full?: boolean; recover?: boolean } = {},
): Promise<{ exitCode: number }> {
	const logger = new Logger("Doctor");
	let exitCode = 0;

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

			// Signal non-zero exit on corruption
			exitCode = 1;
		}
	} catch (error) {
		console.log(`❌ Check failed: ${error}`);
		logger.error(`Integrity check error: ${error}`);
		exitCode = 1;
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
	const displayed = tables.slice(0, 5);
	for (const table of displayed) {
		const bytes = table.dataBytes
			? ` (${(table.dataBytes / 1024 / 1024).toFixed(2)} MB)`
			: "";
		console.log(`  ${table.name}: ${table.rowCount} rows${bytes}`);
	}
	if (tables.length > 5) {
		console.log(`  ... and ${tables.length - 5} more tables`);
	}

	// Recovery instructions
	if (options.recover || exitCode === 1) {
		console.log("\n🔧 Recovery Instructions:");
		const instructions = dbOps.generateRecoveryInstructions();
		console.log(instructions);
	}

	console.log("═".repeat(50));

	if (exitCode === 1) {
		console.log("\n❌ Doctor found issues. Review output above.");
	} else {
		console.log("\n✅ Doctor check complete. No issues found.");
	}

	return { exitCode };
}
