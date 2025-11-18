import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { REFRESH_TOKEN_HEALTH_CHECK_INTERVAL_MS } from "../constants";
import {
	checkAllAccountsHealth,
	getAccountsNeedingReauth,
	type TokenHealthReport,
} from "./token-health-monitor";

const log = new Logger("TokenHealthService");

export interface TokenHealthService {
	startHealthChecks(getAccounts: () => Account[]): void;
	stopHealthChecks(): void;
	getLastHealthReport(): TokenHealthReport | null;
	forceHealthCheck(getAccounts: () => Account[]): Promise<TokenHealthReport>;
}

export function createTokenHealthService(): TokenHealthService {
	let healthCheckInterval: Timer | null = null;
	let lastHealthReport: TokenHealthReport | null = null;

	const performHealthCheck = async (
		getAccounts: () => Account[],
	): Promise<void> => {
		try {
			const accounts = getAccounts();
			const healthReport = checkAllAccountsHealth(accounts);
			lastHealthReport = healthReport;

			// Log warnings for accounts needing re-authentication
			const needsReauth = getAccountsNeedingReauth(accounts);
			if (needsReauth.length > 0) {
				log.warn(`🔄 ${needsReauth.length} account(s) need re-authentication:`);
				needsReauth.forEach((account) => {
					log.warn(`  - ${account.name} (${account.provider})`);
				});
				log.warn(
					"Run 'bun run cli --reauth-needed' to see details and get re-authentication commands.",
				);
			}

			// Log summary statistics
			const { summary } = healthReport;
			if (
				summary.requiresReauth > 0 ||
				summary.expired > 0 ||
				summary.critical > 0
			) {
				log.warn(
					`🚨 Token Health Summary: ${summary.healthy} healthy, ${summary.warning} warnings, ${summary.critical} critical, ${summary.expired} expired, ${summary.requiresReauth} need re-auth`,
				);
			} else if (summary.warning > 0) {
				log.info(
					`⚠️ Token Health Summary: ${summary.healthy} healthy, ${summary.warning} warnings`,
				);
			} else {
				log.info(
					`✅ Token Health Summary: All ${summary.healthy} accounts healthy`,
				);
			}
		} catch (error) {
			log.error("Failed to perform token health check", error);
		}
	};

	const startHealthChecks = (getAccounts: () => Account[]): void => {
		if (healthCheckInterval) {
			log.warn("Token health checks already running");
			return;
		}

		log.info(
			`Starting token health checks (interval: ${REFRESH_TOKEN_HEALTH_CHECK_INTERVAL_MS / 1000 / 60 / 60} hours)`,
		);

		// Perform initial health check
		performHealthCheck(getAccounts);

		// Schedule periodic health checks
		healthCheckInterval = setInterval(() => {
			performHealthCheck(getAccounts);
		}, REFRESH_TOKEN_HEALTH_CHECK_INTERVAL_MS);
	};

	const stopHealthChecks = (): void => {
		if (healthCheckInterval) {
			clearInterval(healthCheckInterval);
			healthCheckInterval = null;
			log.info("Stopped token health checks");
		}
	};

	const getLastHealthReport = (): TokenHealthReport | null => {
		return lastHealthReport;
	};

	const forceHealthCheck = async (
		getAccounts: () => Account[],
	): Promise<TokenHealthReport> => {
		await performHealthCheck(getAccounts);
		return lastHealthReport!;
	};

	return {
		startHealthChecks,
		stopHealthChecks,
		getLastHealthReport,
		forceHealthCheck,
	};
}

// Global instance for the proxy server
let globalTokenHealthService: TokenHealthService | null = null;

export function getGlobalTokenHealthService(): TokenHealthService {
	if (!globalTokenHealthService) {
		globalTokenHealthService = createTokenHealthService();
	}
	return globalTokenHealthService;
}

export function startGlobalTokenHealthChecks(
	getAccounts: () => Account[],
): void {
	getGlobalTokenHealthService().startHealthChecks(getAccounts);
}

export function stopGlobalTokenHealthChecks(): void {
	getGlobalTokenHealthService().stopHealthChecks();
}
