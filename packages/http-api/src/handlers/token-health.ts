import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import {
	checkAllAccountsHealthWithRefreshRuntime,
	checkRefreshTokenHealth,
	enrichTokenHealthWithRefreshRuntime,
	getAccountsNeedingReauth,
} from "@better-ccflare/proxy";

/**
 * Create a token health handler for all accounts
 */
export function createTokenHealthHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const accounts = await dbOps.getAllAccounts();
		const healthReport = checkAllAccountsHealthWithRefreshRuntime(accounts);

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
	return async (): Promise<Response> => {
		const accounts = await dbOps.getAllAccounts();
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
	return async (): Promise<Response> => {
		// Validate account name parameter - allow common characters
		// Account names can contain alphanumeric, spaces, hyphens, underscores, and dots
		if (!accountName || accountName.trim().length === 0) {
			return jsonResponse(
				{
					success: false,
					error: "Account name cannot be empty",
				},
				400,
			);
		}

		// Find account by name from all accounts
		const accounts = await dbOps.getAllAccounts();
		const account = accounts.find((a) => a.name === accountName);

		if (!account) {
			return jsonResponse(
				{
					success: false,
					error: `Account '${accountName}' not found`,
				},
				404,
			);
		}

		return jsonResponse({
			success: true,
			data: enrichTokenHealthWithRefreshRuntime(
				checkRefreshTokenHealth(account),
			),
		});
	};
}
