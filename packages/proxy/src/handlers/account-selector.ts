import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of ordered accounts
 */
export function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
): Account[] {
	const allAccounts = ctx.dbOps.getAllAccounts();
	// Return all accounts - the provider will be determined dynamically per account
	return ctx.strategy.select(allAccounts, meta);
}

/**
 * Selects accounts for a request based on the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of selected accounts
 */
export function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ProxyContext,
): Account[] {
	// Check if a specific account is requested via special header
	if (meta.headers) {
		const forcedAccountId = meta.headers.get("x-better-ccflare-account-id");
		if (forcedAccountId) {
			const allAccounts = ctx.dbOps.getAllAccounts();
			const forcedAccount = allAccounts.find(
				(acc) => acc.id === forcedAccountId,
			);
			if (forcedAccount) {
				return [forcedAccount];
			}
			// If forced account not found, fall back to normal selection
		}
	}

	return getOrderedAccounts(meta, ctx);
}
