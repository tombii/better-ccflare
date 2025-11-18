import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import {
	checkAllAccountsHealth,
	checkRefreshTokenHealth,
	getAccountsNeedingReauth,
} from "@better-ccflare/proxy";

/**
 * Create a token health handler for all accounts
 */
export function createTokenHealthHandler(dbOps: DatabaseOperations) {
	return (): Response => {
		const accounts = dbOps.getAllAccounts();
		const healthReport = checkAllAccountsHealth(accounts);

		return jsonResponse({
			success: true,
			data: healthReport,
		});
	};
}

/**
 * Create a re-authentication needed handler
 */
export function createReauthNeededHandler(dbOps: DatabaseOperations) {
	return (): Response => {
		const accounts = dbOps.getAllAccounts();
		const needsReauth = getAccountsNeedingReauth(accounts);

		return jsonResponse({
			success: true,
			data: {
				accounts: needsReauth,
				count: needsReauth.length,
				needsReauth: needsReauth.length > 0,
			},
		});
	};
}

/**
 * Create account token health handler
 */
export function createAccountTokenHealthHandler(
	dbOps: DatabaseOperations,
	accountName: string,
) {
	return (): Response => {
		const account = dbOps.getAccount(accountName);
		if (!account) {
			return jsonResponse(
				{
					success: false,
					error: `Account '${accountName}' not found`,
				},
				404,
			);
		}

		const tokenHealth = checkRefreshTokenHealth(account);

		return jsonResponse({
			success: true,
			data: tokenHealth,
		});
	};
}
