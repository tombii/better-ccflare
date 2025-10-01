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
	return getOrderedAccounts(meta, ctx);
}
