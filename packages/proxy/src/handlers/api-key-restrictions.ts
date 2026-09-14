import { getModelFamily, KNOWN_PATTERNS } from "@better-ccflare/core";
import type {
	Account,
	ApiKeyRestrictions,
	RequestMeta,
} from "@better-ccflare/types";

/**
 * Per-API-key restrictions: which accounts, models and providers a key may use.
 *
 * Two invariants hold everywhere in this file:
 *
 *   - `null` on a list means UNRESTRICTED. `[]` means DENY-ALL. They are not
 *     interchangeable, and every predicate below distinguishes them.
 *   - Absence of a restriction object at all (`null` / `undefined`) is the
 *     zero-keys / unrestricted-key case and must be a total no-op. A key with
 *     all three columns NULL behaves exactly as it did before this feature
 *     existed, and so does a proxy running with no API keys configured (auth is
 *     disabled then and no key record exists to carry restrictions).
 *
 * Internal probes are exempted by the CALLERS, not here: the exemption is keyed
 * on `isInternalProbe`, which verifies the process-local probe secret, and the
 * predicate has no access to request headers. See the three call sites in
 * account-selector.ts and the one in proxy.ts.
 */

/** A family name is a legal `allowedModels` entry and matches the whole family. */
const FAMILY_NAMES: ReadonlySet<string> = new Set<string>(KNOWN_PATTERNS);

/**
 * Does this key restrict which accounts may serve it?
 *
 * Both the account allowlist and the provider allowlist narrow the same pool,
 * so they share one predicate — the callers that filter accounts need to know
 * only whether any filtering applies at all.
 */
export function restrictsAccountPool(
	restrictions: ApiKeyRestrictions | null | undefined,
): boolean {
	if (!restrictions) return false;
	return (
		restrictions.allowedAccounts !== null ||
		restrictions.allowedProviders !== null
	);
}

/** Does this key restrict which models may be requested? */
export function restrictsModels(
	restrictions: ApiKeyRestrictions | null | undefined,
): boolean {
	return !!restrictions && restrictions.allowedModels !== null;
}

/**
 * May this key route a request to this account?
 *
 * Both lists must allow it when both are set: they are independent narrowings,
 * not alternatives. A restriction naming an account that has since been deleted
 * simply matches nothing — the safe failure direction, and the reason these are
 * JSON-array columns rather than a cascading join table.
 */
export function isAccountAllowedForApiKey(
	account: Account,
	restrictions: ApiKeyRestrictions | null | undefined,
): boolean {
	if (!restrictions) return true;

	const { allowedAccounts, allowedProviders } = restrictions;

	if (allowedAccounts !== null && !allowedAccounts.includes(account.id)) {
		return false;
	}

	if (allowedProviders !== null) {
		// Provider is nullable on the account row and defaults to anthropic
		// everywhere else in the proxy; keep that reading identical here so a
		// key allowed "anthropic" covers legacy rows with no provider set.
		const provider = (account.provider ?? "anthropic").toLowerCase();
		if (!allowedProviders.some((entry) => entry.toLowerCase() === provider)) {
			return false;
		}
	}

	return true;
}

/**
 * May this key request this model?
 *
 * Entries are matched two ways, and only two:
 *
 *   - an exact (case-insensitive) model id, which allows that model and nothing
 *     else — a key allowed "claude-opus-4-8" may NOT use "claude-opus-4-5";
 *   - one of the four family names, which allows every model in that family —
 *     a key allowed "opus" may use any opus model.
 *
 * Deriving a family from a non-family entry would silently widen the first case
 * into the second, so `getModelFamily` is applied to the REQUESTED model only,
 * and only when the entry is itself a family name.
 *
 * A request that names no model is not evaluated: a model allowlist governs the
 * model a client asks for, and a request that asks for none cannot violate it.
 * Such a request is still subject to the account and provider allowlists.
 */
export function isModelAllowedForApiKey(
	model: string | null | undefined,
	restrictions: ApiKeyRestrictions | null | undefined,
): boolean {
	if (!restrictions) return true;
	const { allowedModels } = restrictions;
	if (allowedModels === null) return true;
	if (!model) return true;

	const requested = model.toLowerCase();
	const requestedFamily = getModelFamily(model);

	return allowedModels.some((entry) => {
		const candidate = entry.toLowerCase();
		if (candidate === requested) return true;
		return FAMILY_NAMES.has(candidate) && candidate === requestedFamily;
	});
}

/** Which allowlist(s) narrowed the account pool. */
export type ApiKeyRestrictionScope =
	| "accounts"
	| "providers"
	| "accounts and providers"
	| "forced account";

/** Human-readable name of whichever list(s) narrow the account pool. */
export function summarizeAccountRestrictionScope(
	restrictions: ApiKeyRestrictions | null | undefined,
): ApiKeyRestrictionScope {
	const byAccount = restrictions?.allowedAccounts != null;
	const byProvider = restrictions?.allowedProviders != null;
	if (byAccount && byProvider) return "accounts and providers";
	if (byProvider) return "providers";
	return "accounts";
}

/**
 * Why an API key's restrictions left no account able to serve a request.
 *
 * Recorded by account selection and read by proxy.ts so the refusal can say
 * "policy", not "capacity". Without it the empty pool would fall through to the
 * generic `pool_exhausted` 503, which advertises a Retry-After for a condition
 * that no amount of waiting changes.
 */
export interface ApiKeyRestrictionDenial {
	/** Which allowlist(s) did the removing. */
	scope: ApiKeyRestrictionScope;
	/** How many otherwise-eligible accounts the restriction removed. */
	removed: number;
	/** The account named by `x-better-ccflare-account-id`, when that was refused. */
	forcedAccountName?: string;
}

// Module-level WeakMap keyed by RequestMeta, mirroring comboSlotInfoMap and
// exhaustionInfoMap in account-selector.ts rather than widening RequestMeta's
// shape. This is the RETURN path (selection tells the proxy why it refused);
// the restrictions themselves travel DOWN as an explicit parameter.
const restrictionDenialMap = new WeakMap<
	RequestMeta,
	ApiKeyRestrictionDenial
>();

/** Record that an API key's restrictions emptied the candidate pool. */
export function setApiKeyRestrictionDenial(
	meta: RequestMeta,
	denial: ApiKeyRestrictionDenial,
): void {
	restrictionDenialMap.set(meta, denial);
}

/** Read back a restriction denial for this request (null if none). */
export function getApiKeyRestrictionDenial(
	meta: RequestMeta,
): ApiKeyRestrictionDenial | null {
	return restrictionDenialMap.get(meta) ?? null;
}
