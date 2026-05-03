import { TIME_CONSTANTS } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

const DEFAULT_INTERVAL_HOURS = 6;

export function startIntegrityScheduler(
	dbOps: DatabaseOperations,
	intervalHours?: number,
): () => void {
	const logger = new Logger("IntegrityScheduler");

	let interval =
		(intervalHours ?? DEFAULT_INTERVAL_HOURS) * TIME_CONSTANTS.HOUR;

	const envInterval = process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL;
	if (envInterval !== undefined) {
		const parsed = parseInt(envInterval, 10);
		if (Number.isNaN(parsed) || parsed < 0) {
			logger.warn(
				`Invalid CCFLARE_INTEGRITY_CHECK_INTERVAL="${envInterval}", using default ${DEFAULT_INTERVAL_HOURS}h`,
			);
		} else if (parsed === 0) {
			logger.info(
				"Integrity scheduler disabled (CCFLARE_INTEGRITY_CHECK_INTERVAL=0)",
			);
			return () => {};
		} else {
			interval = parsed * TIME_CONSTANTS.HOUR;
		}
	}

	const checkIntegrity = async () => {
		try {
			logger.debug("Running quick integrity check...");
			const result = await dbOps.runQuickIntegrityCheck();

			if (result === "ok") {
				dbOps.updateIntegrityStatus("ok");
				logger.debug("Integrity check passed");
			} else {
				dbOps.updateIntegrityStatus("corrupt", result);
				logger.error(`Integrity check FAILED: ${result}`);
				logger.error(
					"Database corruption detected. Run `bun run cli --doctor` for details.",
				);
			}
		} catch (error) {
			logger.error(`Integrity check error: ${error}`);
			dbOps.updateIntegrityStatus("corrupt", String(error));
		}
	};

	// Run initial check after 30s startup grace period
	const timeoutId = setTimeout(checkIntegrity, 30 * TIME_CONSTANTS.SECOND);

	// Schedule periodic checks
	const intervalId = setInterval(checkIntegrity, interval);

	// Return cleanup function
	return () => {
		clearTimeout(timeoutId);
		clearInterval(intervalId);
		logger.info("Integrity scheduler stopped");
	};
}
