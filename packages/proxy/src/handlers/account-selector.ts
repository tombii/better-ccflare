import { getModelFamily, isAccountAvailable } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	ComboFamily,
	ComboSlotInfo,
	RequestMeta,
} from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("AccountSelector");

// Module-level WeakMap to store combo slot info per RequestMeta
const comboSlotInfoMap = new WeakMap<RequestMeta, ComboSlotInfo>();

/** Store combo slot info on a RequestMeta for downstream consumption */
export function setComboSlotInfo(meta: RequestMeta, info: ComboSlotInfo): void {
	comboSlotInfoMap.set(meta, info);
}

/** Retrieve combo slot info from a RequestMeta (null if not combo-routed) */
export function getComboSlotInfo(meta: RequestMeta): ComboSlotInfo | null {
	return comboSlotInfoMap.get(meta) ?? null;
}

/**
 * Resolves the model that should drive account routing: the agent
 * interceptor's applied (post-rewrite) model when it modified the request,
 * falling back to the original client-requested model otherwise. Routing
 * must see the model that will actually be sent upstream — combo routing
 * and family-based selection would otherwise match against a model the
 * outgoing request no longer carries.
 */
export function resolveEffectiveModel(
	appliedModel: string | null | undefined,
	requestModel: string | null | undefined,
): string | null {
	return appliedModel ?? requestModel ?? null;
}

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of ordered accounts
 */
export async function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
): Promise<Account[]> {
	try {
		const allAccounts = await ctx.dbOps.getAllAccounts();
		// Return all accounts - the provider will be determined dynamically per account
		return ctx.strategy.select(allAccounts, meta);
	} catch (error) {
		log.error("Failed to get accounts from database:", error);
		console.error("\n❌ DATABASE ERROR DETECTED");
		console.error("═".repeat(50));
		console.error("The database encountered an error while loading accounts.");
		console.error(
			"This may indicate database corruption or integrity issues.\n",
		);
		console.error("To diagnose and repair the database, run:");
		console.error("  bun run cli --repair-db\n");
		console.error("The request will fall back to unauthenticated mode.");
		console.error(`${"═".repeat(50)}\n`);
		// Return empty array to gracefully handle database errors
		// This will cause the proxy to fall back to unauthenticated mode
		return [];
	}
}

/**
 * Selects accounts for a request based on the load balancing strategy.
 * When an active combo exists for the request's model family, returns
 * combo-ordered accounts filtered by availability. Falls back to normal
 * SessionStrategy when no combo is active or all slots are unavailable.
 *
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @param model - Optional model string for combo family detection
 * @returns Array of selected accounts
 */
export async function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ProxyContext,
	model?: string,
): Promise<Account[]> {
	// Check if a specific account is requested via special header
	if (meta.headers) {
		const forcedAccountId = meta.headers.get("x-better-ccflare-account-id");
		if (forcedAccountId) {
			try {
				const allAccounts = await ctx.dbOps.getAllAccounts();
				const forcedAccount = allAccounts.find(
					(acc) => acc.id === forcedAccountId,
				);
				if (forcedAccount) {
					// The auto-refresh scheduler sends dummy messages with x-better-ccflare-bypass-session
					// to intentionally refresh accounts that are paused due to auto_pause_on_overage,
					// or to probe accounts that are rate-limited (to detect when the window has reset).
					// For those requests we must allow through an overage-paused or rate-limited account
					// so the scheduler can hit the real endpoint and trigger the window-reset + auto-resume logic.
					// Only an overage pause qualifies: a manual pause (pause_reason='manual') or a
					// failure-threshold / peak_hours pause must still win even when the overage feature
					// flag is enabled, because the auto-resume guard would never un-pause those accounts.
					// This mirrors the scheduler eligibility query and the sendDummyMessage resume guard
					// (auto_pause_on_overage_enabled=1 AND pause_reason IN (NULL,'overage')).
					const isAutoRefreshBypass =
						meta.headers.get("x-better-ccflare-bypass-session") === "true";
					const available = isAccountAvailable(forcedAccount);
					const isOveragePaused =
						forcedAccount.paused &&
						forcedAccount.auto_pause_on_overage_enabled &&
						(!forcedAccount.pause_reason ||
							forcedAccount.pause_reason === "overage");
					const isRateLimited =
						!available &&
						!forcedAccount.paused &&
						!!forcedAccount.rate_limited_until;
					const allowThrough =
						available ||
						(isAutoRefreshBypass && (isOveragePaused || isRateLimited));
					if (allowThrough) {
						return [forcedAccount];
					}
				}
				// If forced account not found or unavailable (paused/rate-limited), fall back to normal selection
			} catch (error) {
				log.error(
					"Failed to get accounts from database for forced account lookup:",
					error,
				);
				console.error("\n❌ DATABASE ERROR DETECTED");
				console.error("═".repeat(50));
				console.error(
					"The database encountered an error while looking up the requested account.",
				);
				console.error(
					"This may indicate database corruption or integrity issues.\n",
				);
				console.error("To diagnose and repair the database, run:");
				console.error("  bun run cli --repair-db\n");
				console.error("Falling back to normal account selection.");
				console.error(`${"═".repeat(50)}\n`);
				// Fall through to normal selection
			}
		}
	}

	// Filter out excluded providers (e.g. claude-oauth excluded by the responses adapter)
	const excludeProviders =
		meta.headers
			?.get("x-better-ccflare-exclude-providers")
			?.split(",")
			.map((p) => p.trim())
			.filter(Boolean) ?? [];

	const applyExclusions = (accounts: Account[]): Account[] => {
		if (excludeProviders.length === 0) return accounts;
		const filtered = accounts.filter((a) => {
			for (const ex of excludeProviders) {
				// "anthropic-oauth" targets only Anthropic OAuth accounts (refresh_token present),
				// leaving Anthropic API key accounts (console mode) eligible.
				if (ex === "anthropic-oauth") {
					if (a.provider === "anthropic" && a.refresh_token != null)
						return false;
				} else {
					if (a.provider === ex) return false;
				}
			}
			return true;
		});
		const skipped = accounts.length - filtered.length;
		if (skipped > 0) {
			log.warn(
				`Skipping ${skipped} account(s) excluded for this request type (Codex CLI traffic must not use Anthropic OAuth accounts)`,
			);
		}
		return filtered;
	};

	// Try combo-aware routing if a model is provided
	if (model) {
		const family = getModelFamily(model);
		if (family) {
			const validFamilies: readonly string[] = [
				"fable",
				"opus",
				"sonnet",
				"haiku",
			];
			if (!validFamilies.includes(family)) {
				log.warn(`Unknown model family "${family}", skipping combo lookup`);
			} else {
				const combo = await ctx.dbOps.getActiveComboForFamily(
					family as ComboFamily,
				);
				if (combo) {
					log.info(
						`Combo routing active: ${combo.name} for family ${family} (${combo.slots.length} slots)`,
					);

					const allAccounts = await ctx.dbOps.getAllAccounts();
					const accountMap = new Map<string, Account>();
					for (const account of allAccounts) {
						accountMap.set(account.id, account);
					}

					const availableAccounts: Account[] = [];
					const slotEntries: Array<{
						accountId: string;
						modelOverride: string;
					}> = [];

					// Slots are already ordered by priority ASC from the repository
					for (const slot of combo.slots) {
						if (!slot.enabled) continue;

						const account = accountMap.get(slot.account_id);
						if (!account) {
							log.warn(
								`Combo slot references unknown account ${slot.account_id}`,
							);
							continue;
						}

						if (!isAccountAvailable(account)) {
							continue;
						}

						availableAccounts.push(account);
						slotEntries.push({
							accountId: slot.account_id,
							modelOverride: slot.model,
						});
					}

					// Store combo slot info for downstream consumption
					const slotInfo: ComboSlotInfo = {
						comboName: combo.name,
						slots: slotEntries,
					};
					setComboSlotInfo(meta, slotInfo);
					meta.comboName = combo.name;

					const filteredComboAccounts = applyExclusions(availableAccounts);
					if (filteredComboAccounts.length > 0) {
						return filteredComboAccounts;
					}

					// All slots unavailable — fall back to normal routing
					log.warn(
						`All ${combo.slots.length} combo slots unavailable for ${combo.name}, falling back to SessionStrategy`,
					);
				}
			}
		}
	}

	return applyExclusions(await getOrderedAccounts(meta, ctx));
}
