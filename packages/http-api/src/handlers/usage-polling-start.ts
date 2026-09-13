import { Logger } from "@better-ccflare/logger";
import { restartUsagePollingForAccount } from "@better-ccflare/proxy";

const log = new Logger("UsagePollingStart");

/**
 * Best-effort: start usage polling for a freshly created account.
 *
 * Without this, `startUsagePollingWithRefresh` only ever runs for the accounts
 * that existed when the server booted — an account added at runtime (dashboard
 * device flow, OAuth callback, `POST /api/accounts`) would show no usage until
 * the process restarted.
 *
 * The server decides whether the provider is pollable; a `false` return is
 * normal for providers without a polling endpoint. Never throws and never
 * affects the HTTP response.
 */
export async function startUsagePollingForNewAccount(
	accountId: string,
	accountName: string,
): Promise<boolean> {
	try {
		const started = await restartUsagePollingForAccount(accountId);
		if (started) {
			log.info(`Started usage polling for new account '${accountName}'`);
		} else {
			log.debug(
				`No server started usage polling for new account '${accountName}' (provider is not pollable or no server is registered)`,
			);
		}
		return started;
	} catch (error) {
		log.warn(
			`Failed to start usage polling for new account '${accountName}': ${error}`,
		);
		return false;
	}
}
