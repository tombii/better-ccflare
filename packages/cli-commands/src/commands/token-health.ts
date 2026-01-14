import type { DatabaseOperations } from "@better-ccflare/database";
import {
	checkAllAccountsHealth,
	formatTokenHealthReport,
	getAccountsNeedingReauth,
} from "@better-ccflare/proxy";

/**
 * Check token health for all accounts
 */
export function checkTokenHealth(dbOps: DatabaseOperations): void {
	const accounts = dbOps.getAllAccounts();
	const healthReport = checkAllAccountsHealth(accounts);

	console.log(formatTokenHealthReport(healthReport));
}

/**
 * Check accounts that need re-authentication
 */
export function checkReauthNeeded(dbOps: DatabaseOperations): void {
	const accounts = dbOps.getAllAccounts();
	const needsReauth = getAccountsNeedingReauth(accounts);

	if (needsReauth.length === 0) {
		console.log(
			"✅ All accounts have valid tokens. No re-authentication needed.",
		);
		return;
	}

	console.log(
		`🔄 Found ${needsReauth.length} account(s) that need re-authentication:\n`,
	);

	needsReauth.forEach((account) => {
		console.log(`  - ${account.name} (${account.provider})`);
	});

	console.log("\n🔧 Re-authentication commands:");
	needsReauth.forEach((account) => {
		console.log(`  bun run cli --reauthenticate "${account.name}"`);
	});

	console.log("\n💡 Or run the health check for detailed information:");
	console.log("  bun run cli --token-health");
}

/**
 * Quick status check for scripts
 */
export function getTokenHealthStatus(dbOps: DatabaseOperations): {
	healthy: boolean;
	needsReauth: number;
	expired: number;
} {
	const accounts = dbOps.getAllAccounts();
	const healthReport = checkAllAccountsHealth(accounts);

	return {
		healthy: healthReport.summary.requiresReauth === 0,
		needsReauth: healthReport.summary.requiresReauth,
		expired: healthReport.summary.expired,
	};
}
