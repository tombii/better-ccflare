import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { REFRESH_TOKEN_MAX_AGE_MS } from "../constants";

const log = new Logger("TokenHealthMonitor");

export interface TokenHealthStatus {
	accountId: string;
	accountName: string;
	provider: string;
	hasRefreshToken: boolean;
	refreshTokenAge?: number;
	refreshTokenAgeDays?: number;
	status: "healthy" | "warning" | "critical" | "expired" | "no-refresh-token";
	message: string;
	daysUntilExpiration?: number;
	requiresReauth: boolean;
}

export interface TokenHealthReport {
	accounts: TokenHealthStatus[];
	summary: {
		total: number;
		healthy: number;
		warning: number;
		critical: number;
		expired: number;
		noRefreshToken: number;
		requiresReauth: number;
	};
	timestamp: number;
}

/**
 * Check the health of a refresh token for an account
 */
export function checkRefreshTokenHealth(account: Account): TokenHealthStatus {
	const now = Date.now();
	const accountId = account.id;
	const accountName = account.name;
	const provider = account.provider;

	// Check if account has refresh token (OAuth accounts)
	const hasRefreshToken = !!account.refresh_token;
	if (!hasRefreshToken) {
		return {
			accountId,
			accountName,
			provider,
			hasRefreshToken: false,
			status: "no-refresh-token",
			message: account.api_key
				? "API key account (no refresh token needed)"
				: "OAuth account missing refresh token - requires re-authentication",
			requiresReauth: !account.api_key, // API key accounts don't need reauth
		};
	}

	// For OAuth accounts, check refresh token age
	if (!account.created_at) {
		return {
			accountId,
			accountName,
			provider,
			hasRefreshToken: true,
			status: "warning",
			message:
				"Refresh token has unknown creation date - recommend re-authentication",
			requiresReauth: true,
		};
	}

	const refreshTokenAge = now - account.created_at;
	const refreshTokenAgeDays = Math.floor(
		refreshTokenAge / (24 * 60 * 60 * 1000),
	);
	const estimatedExpirationDate = account.created_at + REFRESH_TOKEN_MAX_AGE_MS;
	const daysUntilExpiration = Math.ceil(
		(estimatedExpirationDate - now) / (24 * 60 * 60 * 1000),
	);

	// Determine health status
	let status: TokenHealthStatus["status"];
	let message: string;
	let requiresReauth = false;

	if (daysUntilExpiration <= 0) {
		status = "expired";
		message = `Refresh token expired ~${Math.abs(daysUntilExpiration)} days ago - requires immediate re-authentication`;
		requiresReauth = true;
	} else if (daysUntilExpiration <= 3) {
		status = "critical";
		message = `Refresh token expires in ${daysUntilExpiration} days - immediate re-authentication required`;
		requiresReauth = true;
	} else if (daysUntilExpiration <= 7) {
		status = "warning";
		message = `Refresh token expires in ${daysUntilExpiration} days - re-authentication recommended soon`;
		requiresReauth = false;
	} else if (refreshTokenAgeDays > 60) {
		status = "warning";
		message = `Refresh token is ${refreshTokenAgeDays} days old - monitor for expiration`;
		requiresReauth = false;
	} else {
		status = "healthy";
		message = `Refresh token is healthy (expires in ~${daysUntilExpiration} days)`;
		requiresReauth = false;
	}

	return {
		accountId,
		accountName,
		provider,
		hasRefreshToken: true,
		refreshTokenAge,
		refreshTokenAgeDays,
		status,
		message,
		daysUntilExpiration,
		requiresReauth,
	};
}

/**
 * Check health of all accounts
 */
export function checkAllAccountsHealth(accounts: Account[]): TokenHealthReport {
	const accountHealthStatuses = accounts.map(checkRefreshTokenHealth);

	const summary = {
		total: accountHealthStatuses.length,
		healthy: accountHealthStatuses.filter((a) => a.status === "healthy").length,
		warning: accountHealthStatuses.filter((a) => a.status === "warning").length,
		critical: accountHealthStatuses.filter((a) => a.status === "critical")
			.length,
		expired: accountHealthStatuses.filter((a) => a.status === "expired").length,
		noRefreshToken: accountHealthStatuses.filter(
			(a) => a.status === "no-refresh-token",
		).length,
		requiresReauth: accountHealthStatuses.filter((a) => a.requiresReauth)
			.length,
	};

	const report: TokenHealthReport = {
		accounts: accountHealthStatuses,
		summary,
		timestamp: Date.now(),
	};

	// Log warnings for problematic accounts
	const criticalAccounts = accountHealthStatuses.filter(
		(a) => a.status === "critical" || a.status === "expired",
	);
	if (criticalAccounts.length > 0) {
		log.warn(`🚨 Critical token health issues detected:`);
		criticalAccounts.forEach((account) => {
			log.warn(`  - ${account.accountName}: ${account.message}`);
		});
	}

	const warningAccounts = accountHealthStatuses.filter(
		(a) => a.status === "warning",
	);
	if (warningAccounts.length > 0) {
		log.info(`⚠️  Token health warnings:`);
		warningAccounts.forEach((account) => {
			log.info(`  - ${account.accountName}: ${account.message}`);
		});
	}

	if (summary.healthy > 0) {
		log.info(`✅ ${summary.healthy} accounts have healthy tokens`);
	}

	return report;
}

/**
 * Get OAuth accounts that need re-authentication
 */
export function getAccountsNeedingReauth(accounts: Account[]): Account[] {
	const healthReport = checkAllAccountsHealth(accounts);
	return accounts.filter((account) => {
		const health = healthReport.accounts.find(
			(h) => h.accountId === account.id,
		);
		return health?.requiresReauth;
	});
}

/**
 * Format token health report for CLI output
 */
export function formatTokenHealthReport(report: TokenHealthReport): string {
	const lines: string[] = [];

	lines.push(
		"╭─────────────────────────────────────────────────────────────────╮",
	);
	lines.push(
		"│                    Token Health Report                          │",
	);
	lines.push(
		`│ Generated: ${new Date(report.timestamp).toLocaleString()}                 │`,
	);
	lines.push(
		"╰─────────────────────────────────────────────────────────────────╯",
	);
	lines.push("");

	// Summary
	lines.push("📊 Summary:");
	lines.push(`  Total accounts: ${report.summary.total}`);
	lines.push(`  ✅ Healthy: ${report.summary.healthy}`);
	lines.push(`  ⚠️  Warning: ${report.summary.warning}`);
	lines.push(`  🚨 Critical: ${report.summary.critical}`);
	lines.push(`  💀 Expired: ${report.summary.expired}`);
	lines.push(`  🔑 No refresh token: ${report.summary.noRefreshToken}`);
	lines.push(`  🔄 Need re-auth: ${report.summary.requiresReauth}`);
	lines.push("");

	// Account details
	if (report.accounts.length > 0) {
		lines.push("📋 Account Details:");
		lines.push("");

		report.accounts.forEach((account) => {
			const statusIcon = getStatusIcon(account.status);
			lines.push(`${statusIcon} ${account.accountName} (${account.provider})`);
			lines.push(`   ${account.message}`);

			if (account.daysUntilExpiration !== undefined) {
				lines.push(`   Days until expiration: ${account.daysUntilExpiration}`);
			}

			if (account.refreshTokenAgeDays !== undefined) {
				lines.push(`   Token age: ${account.refreshTokenAgeDays} days`);
			}

			if (account.requiresReauth) {
				lines.push(
					`   🔄 Action required: run 'bun run cli --reauthenticate ${account.accountName}'`,
				);
			}

			lines.push("");
		});
	}

	if (report.summary.requiresReauth > 0) {
		lines.push("🔧 Recommended Actions:");
		const needsReauth = report.accounts.filter((a) => a.requiresReauth);
		needsReauth.forEach((account) => {
			lines.push(`  bun run cli --reauthenticate ${account.accountName}`);
		});
		lines.push("");
	}

	return lines.join("\n");
}

function getStatusIcon(status: TokenHealthStatus["status"]): string {
	switch (status) {
		case "healthy":
			return "✅";
		case "warning":
			return "⚠️";
		case "critical":
			return "🚨";
		case "expired":
			return "💀";
		case "no-refresh-token":
			return "🔑";
		default:
			return "❓";
	}
}

/**
 * Check if an OAuth account's refresh token is likely expired based on age
 */
export function isRefreshTokenLikelyExpired(account: Account): boolean {
	if (!account.refresh_token || !account.created_at) {
		return true; // Missing token or creation date = assume expired
	}

	const age = Date.now() - account.created_at;
	return age > REFRESH_TOKEN_MAX_AGE_MS;
}

/**
 * Get enhanced error message for OAuth token failures
 */
export function getOAuthErrorMessage(
	account: Account,
	originalError: string,
): string {
	const health = checkRefreshTokenHealth(account);

	if (health.status === "expired" || health.status === "critical") {
		return `OAuth tokens have expired for account '${account.name}'. Please re-authenticate: bun run cli --reauthenticate ${account.name}`;
	}

	if (health.status === "no-refresh-token" && health.requiresReauth) {
		return `OAuth account '${account.name}' missing refresh token. Please re-authenticate: bun run cli --reauthenticate ${account.name}`;
	}

	if (health.status === "warning") {
		return `OAuth tokens for account '${account.name}' are nearing expiration. Consider re-authenticating soon: bun run cli --reauthenticate ${account.name}. Original error: ${originalError}`;
	}

	return `OAuth token refresh failed for account '${account.name}': ${originalError}`;
}
