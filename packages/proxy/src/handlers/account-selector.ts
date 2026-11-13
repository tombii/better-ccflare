import type { AccountUsageSnapshot } from "@better-ccflare/core";
import {
	getModelFamily,
	isAccountAvailable,
	isUsageExhausted,
	providerAcceptsClientModel,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	getRepresentativeUsageSnapshotForProvider,
	isOfficialXaiEndpoint,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	ApiKeyRestrictions,
	ComboFamily,
	ComboSlotInfo,
	RequestMeta,
} from "@better-ccflare/types";
import { getKnownCodexModels } from "../codex-model-catalog";
import {
	isAccountAllowedForApiKey,
	restrictsAccountPool,
	setApiKeyRestrictionDenial,
	summarizeAccountRestrictionScope,
} from "./api-key-restrictions";
import {
	type FamilyExhaustionOrigin,
	getFamilyExhaustionOrigin,
	getFamilyExhaustionUntil,
	isAccountExhaustedForModel,
	type ModelFamilyExhaustionInfo,
} from "./model-capacity";
import { getModelCooldownUntil } from "./model-cooldown";
import { isInternalProbe, type ProxyContext } from "./proxy-types";

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
 * A candidate this request could have been routed to, but that the selector
 * dropped for a reason that clears on its own — a usage cap, a rate-limit
 * cooldown, a pause, an expired credential, a model-scoped capacity exclusion.
 *
 * proxy.ts reads the list before it answers an image request terminally: a
 * deferred candidate whose capability is still unknown means the request might
 * have succeeded once the deferral cleared, so the answer has to stay
 * retryable. Only a candidate the vision capability cache already knows to be
 * blind stops blocking, which is the whole reason the verdict is built on the
 * cache — knowledge survives cooldowns, probes and capacity filters, and
 * availability does not.
 *
 * `modelOverride` is shaped exactly like {@link ComboSlotInfo}'s entry: the
 * model this candidate WOULD have been asked for, or null when it would have
 * carried the request's own model. The pool path always records null rather
 * than the routing model the selector was handed, because the vision cache is
 * keyed on the request body's own model string and an agent-preference rewrite
 * makes the two differ. Resolving null against the body in proxy.ts is what
 * keeps this read key byte-identical to the write key — see `visionKeyModel` in
 * proxy-operations.ts and `visionSkipModel` in proxy.ts.
 */
export interface DeferredVisionCandidate {
	accountId: string;
	modelOverride: string | null;
}

/**
 * Whether an account is OUT of rotation indefinitely — a state that waiting
 * cannot clear: a MANUAL pause (the strategy's auto-unpause deliberately skips
 * reason "manual"; overage, peak-hours and failure-threshold pauses lift
 * themselves) or a dead refresh token (`requires_reauth` needs a human to
 * re-authenticate).
 *
 * A candidate only holds the terminal vision verdict open when waiting could
 * plausibly make it serve the image, so an indefinitely held-out account is not
 * a deferred candidate at all — recording one would make the verdict
 * unreachable on any fleet with one such account. `needsReauth` names only
 * accounts the selector actually SELECTED, so an account dropped here is never
 * the one that message asks for.
 *
 * Shared by both deferral recording sites — the pool path (`notePoolDeferrals`
 * below) and the combo-slot recording in the combo branch — so the two cannot
 * drift: any future drop-recording site must apply the same hold-out filter or
 * the verdict silently regresses to inertness on that path.
 */
export function isIndefinitelyHeldOut(account: Account): boolean {
	return Boolean(
		(account.paused && account.pause_reason === "manual") ||
			account.requires_reauth,
	);
}

// Module-level WeakMap, mirroring comboSlotInfoMap above rather than widening
// RequestMeta's shape with a field only one consumer reads.
const deferredCandidatesMap = new WeakMap<
	RequestMeta,
	DeferredVisionCandidate[]
>();

/**
 * Records candidates a selection dropped, ADDING to whatever is already
 * recorded and ignoring duplicates.
 *
 * Additive rather than a replacement because one request can select twice: a
 * combo whose slots all failed re-selects for SessionStrategy fallback (proxy.ts
 * Step 10), and a candidate the first selection deferred is still deferred
 * afterwards. Deduplicated because the two selections overlap heavily, and a
 * pair counted twice would be a pair whose capability is checked twice for one
 * candidate.
 */
export function addDeferredCandidates(
	meta: RequestMeta,
	candidates: readonly DeferredVisionCandidate[],
): void {
	if (candidates.length === 0) return;
	const existing = deferredCandidatesMap.get(meta);
	const seen = new Set(
		existing?.map((c) => `${c.accountId}\u0000${c.modelOverride ?? ""}`) ?? [],
	);
	const merged = existing ? existing.slice() : [];
	for (const candidate of candidates) {
		const key = `${candidate.accountId}\u0000${candidate.modelOverride ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push({ ...candidate });
	}
	deferredCandidatesMap.set(meta, merged);
}

/**
 * The candidates every selection for this request deferred, in the order they
 * were recorded. Empty when nothing was deferred — including for a request that
 * pinned one account with `x-better-ccflare-account-id`, where every other
 * account is permanently ineligible for THIS request rather than deferred, and
 * so correctly does not hold the verdict open.
 */
export function getDeferredCandidates(
	meta: RequestMeta,
): DeferredVisionCandidate[] {
	return deferredCandidatesMap.get(meta) ?? [];
}

// Canonical definition lives in model-capacity.ts (single source of truth —
// a structurally-identical local copy could silently drift).
export type { ModelFamilyExhaustionInfo } from "./model-capacity";

/**
 * Snapshot of an account's representative usage window: returns null when
 * no cached telemetry exists or the provider has no utilization surface
 * (so the caller can fall back to the cheap `isAccountAvailable` check
 * without a usage argument).
 *
 * The shared `isUsageExhausted` predicate lives in `@better-ccflare/core`
 * and encodes both the "utilization >= 100" gate and the staleness guard
 * (a known resetMs in the past means the snapshot predates the window
 * reset and MUST NOT count as exhausted) — same predicate the
 * rateLimitStatus display and /health usage_exhausted counter share, so
 * the surfaces cannot diverge.
 *
 * The snapshot helper pairs the utilization with the reset of the SAME window
 * it came from, which is what makes that staleness guard meaningful for zai
 * too: a stale 100% `time_limit` reading is cleared by its own reset rather
 * than held open by an unrelated token window's future one.
 */
function usageSnapshot(account: Account): AccountUsageSnapshot | null {
	return getRepresentativeUsageSnapshotForProvider(
		usageCache.get(account.id),
		account.provider ?? "anthropic",
	);
}

// Module-level WeakMap to store model-family exhaustion info per RequestMeta,
// set when the capacity filter below removes every candidate account for a
// request's model family. proxy.ts reads this to return a structured
// model_family_exhausted 429 instead of the generic pool_exhausted response.
const exhaustionInfoMap = new WeakMap<RequestMeta, ModelFamilyExhaustionInfo>();

/** Store model-family exhaustion info on a RequestMeta for downstream consumption */
export function setModelFamilyExhaustionInfo(
	meta: RequestMeta,
	info: ModelFamilyExhaustionInfo,
): void {
	exhaustionInfoMap.set(meta, info);
}

/** Retrieve model-family exhaustion info from a RequestMeta (null if not set) */
export function getModelFamilyExhaustionInfo(
	meta: RequestMeta,
): ModelFamilyExhaustionInfo | null {
	return exhaustionInfoMap.get(meta) ?? null;
}

// ── xAI cache-native conversation affinity (issue #319 minimal slice) ──────
//
// Module-level WeakMap to store the derived xAI conv id per RequestMeta,
// mirroring comboSlotInfoMap/exhaustionInfoMap above rather than widening
// RequestMeta's shape. proxy.ts populates this once per request (only when
// the opt-in flag is on and a conv id was derivable — see
// packages/providers/src/providers/xai/cache-native.ts); the header
// attachment seam (proxy-operations.ts) and the affinity logic below are the
// only readers.
const xaiConvIdMap = new WeakMap<RequestMeta, string>();

/** Store a derived xAI conversation id on a RequestMeta for downstream consumption. */
export function setXaiConvId(meta: RequestMeta, convId: string): void {
	xaiConvIdMap.set(meta, convId);
}

/** Retrieve the derived xAI conversation id from a RequestMeta (null if not set). */
export function getXaiConvId(meta: RequestMeta): string | null {
	return xaiConvIdMap.get(meta) ?? null;
}

/**
 * Sticky conv-id -> account ownership table for xAI cache-native affinity.
 *
 * Deliberately module-level (not per-request, not per-strategy-instance):
 * ownership must persist ACROSS requests within the same xAI conversation to
 * keep landing on the same upstream cache partition — that persistence is
 * the entire point of the feature. This is a dedicated mechanism, not a
 * reuse/extension of SessionAffinityStrategy
 * (packages/load-balancer/src/strategies/session-affinity.ts): xai's
 * `requiresSessionTracking` stays `false` in provider-config.ts — cache
 * affinity is a separate concern from Anthropic-style 5-hour session
 * windows and must not piggyback on SessionStrategy/
 * SessionDrainSoonestStrategy.
 *
 * Bounded by XAI_AFFINITY_MAX_ENTRIES with oldest-`assignedAt`-first
 * eviction; entries refresh (their assignedAt bumps forward) on every read
 * so an active conversation never ages out mid-use.
 */
export const XAI_AFFINITY_TTL_MS = 30 * 60 * 1000;
export const XAI_AFFINITY_MAX_ENTRIES = 1024;

interface XaiAffinityEntry {
	accountId: string;
	assignedAt: number;
}

const xaiConvAffinity = new Map<string, XaiAffinityEntry>();

/**
 * Test-only: clear sticky xAI affinity state between test cases. The table
 * is a module-level singleton (by design — see above), so without this,
 * conv ids reused across test files/cases would leak ownership between
 * them.
 */
export function resetXaiCacheAffinityForTests(): void {
	xaiConvAffinity.clear();
}

function evictOldestXaiAffinityEntryIfOverCap(): void {
	if (xaiConvAffinity.size <= XAI_AFFINITY_MAX_ENTRIES) return;
	let oldestKey: string | null = null;
	let oldestAssignedAt = Number.POSITIVE_INFINITY;
	for (const [key, entry] of xaiConvAffinity) {
		if (entry.assignedAt < oldestAssignedAt) {
			oldestAssignedAt = entry.assignedAt;
			oldestKey = key;
		}
	}
	if (oldestKey !== null) {
		xaiConvAffinity.delete(oldestKey);
	}
}

function recordXaiAffinity(
	convId: string,
	accountId: string,
	now: number,
): void {
	xaiConvAffinity.set(convId, { accountId, assignedAt: now });
	evictOldestXaiAffinityEntryIfOverCap();
}

/**
 * Record (or refresh) sticky xAI affinity for `meta`'s conv id onto
 * `accountId` — the account that actually served the request. Callers must
 * only invoke this after confirming a response was actually returned by
 * `accountId`, never at selection time: recording ownership before the
 * request is attempted would wrongly pin a failed leader, since failover to
 * a later candidate never gets a chance to correct it (see proxy.ts call
 * sites, one per `if (response) { return response; }` point). A no-op
 * whenever `meta` carries no conv id (feature disabled or id underivable).
 */
export function recordXaiAffinitySuccess(
	meta: RequestMeta,
	accountId: string,
): void {
	const convId = getXaiConvId(meta);
	if (!convId) return;
	recordXaiAffinity(convId, accountId, Date.now());
}

/**
 * Reorders `accounts` so a conv id's sticky xAI account is tried first, when
 * that account is present in the (already availability-filtered) candidate
 * list and its ownership hasn't expired. A no-op whenever `meta` carries no
 * conv id — which is always true when the feature flag is off, since
 * deriveXaiConvId only ever returns non-null while enabled (see
 * cache-native.ts) and proxy.ts never calls setXaiConvId otherwise.
 *
 * Only called from the two `selectAccountsForRequest` return points that
 * represent ordinary, non-forced, non-combo selection (see call sites
 * below). The forced-account header path and combo routing are both
 * deliberately out of scope for this minimal slice: a forced or
 * combo-assigned account already has an explicit, higher-precedence reason
 * to be first, and reordering either would fight that intent.
 *
 * Read-only with respect to ownership: this only reorders by the EXISTING
 * owner, it never writes one. Ownership is recorded solely by
 * `recordXaiAffinitySuccess`, called from proxy.ts once a response is
 * actually served — recording it here, at selection time, would wrongly pin
 * a presumptive leader that then fails and is failed-over away from, since
 * nothing downstream would get a chance to correct it.
 */
function applyXaiCacheAffinity(
	accounts: Account[],
	meta: RequestMeta,
): Account[] {
	const convId = getXaiConvId(meta);
	if (!convId) return accounts;

	const now = Date.now();
	const isEligible = (a: Account) =>
		a.provider === "xai" && isOfficialXaiEndpoint(a);

	// Promotion is scoped WITHIN the xai candidate subset: the owner moves
	// ahead of OTHER xai accounts only, never ahead of a non-xai account the
	// strategy deliberately preferred (mixed pools are common — an operator
	// running anthropic + xai accounts must not have cross-provider priority
	// overridden by cache affinity). If the strategy leads with a non-xai
	// account, that account still serves; affinity only decides WHICH xai
	// account handles the conversation whenever xai is reached.
	const existing = xaiConvAffinity.get(convId);
	let result = accounts;
	if (existing && now - existing.assignedAt < XAI_AFFINITY_TTL_MS) {
		const firstXaiIdx = accounts.findIndex(isEligible);
		const ownerIdx = accounts.findIndex(
			(a) => a.id === existing.accountId && isEligible(a),
		);
		if (firstXaiIdx !== -1 && ownerIdx > firstXaiIdx) {
			result = accounts.slice();
			const [owner] = result.splice(ownerIdx, 1);
			result.splice(firstXaiIdx, 0, owner);
		}
	}

	return result;
}

/**
 * Whether the model-scoped capacity filter is active. Reads `ctx.config`
 * defensively (optional chaining) so callers/tests that construct a
 * ProxyContext without a `config` mock don't throw — capacity routing then
 * simply behaves as "off", matching the feature's default.
 */
function isCapacityRoutingEnabled(ctx: ProxyContext): boolean {
	return ctx.config?.getModelScopedCapacityRouting?.() === "exhausted";
}

/**
 * Whether combos participate in routing. Reads `ctx.config` defensively, and
 * treats an absent config as enabled — not as the feature's "off" default.
 * The distinction matters: a missing config means there is no operator to ask
 * (a caller or test that built a ProxyContext without one), and before this
 * setting existed routing always consulted the database. Defaulting to "off"
 * there would silently disable combo routing for such callers, which is the
 * exact failure this switch is meant to prevent.
 */
function areCombosEnabled(ctx: ProxyContext): boolean {
	return ctx.config?.getCombosEnabled?.() ?? true;
}

/**
 * Whether the model a client asked for must be the model that is sent.
 * Defaults to off for a context without a config, like every other setting
 * read here.
 */
export function isForceAccountModelEnabled(ctx: ProxyContext): boolean {
	return ctx.config?.getForceAccountModel?.() ?? false;
}

/**
 * Whether `account` can serve `model` exactly as the client wrote it.
 *
 * Two rules, in order:
 *
 * 1. First-hand knowledge. If the account itself has listed the models it
 *    serves, that list is the answer — and a borrowed list from a sibling
 *    account deliberately does not count, since excluding an account on
 *    someone else's evidence is a guess wearing a fact's clothes.
 * 2. Otherwise, the namespace. A Claude model id can only travel untranslated
 *    to a provider that speaks Claude ids, and a non-Claude id only to one
 *    that does not.
 *
 * Rule 2 carries the weight in practice: listings are per-process and start
 * empty after every restart, and some accounts answer 401 on the listing
 * endpoint while serving traffic perfectly. It is coarse — with several
 * non-Claude providers configured, a request can still reach the wrong one —
 * but the failure is then an explicit upstream error, never a silent
 * substitution, which is the promise this setting actually makes.
 */
function accountServesModel(account: Account, model: string): boolean {
	const known =
		account.provider === "codex" ? getKnownCodexModels(account.id) : null;
	if (known) {
		return known.models.some((entry) => entry.id === model);
	}
	return (
		providerAcceptsClientModel(account.provider) === isClaudeModelId(model)
	);
}

function isClaudeModelId(model: string): boolean {
	return getModelFamily(model) !== null;
}

/**
 * Whether a combo whose slots are all unavailable must stop instead of falling
 * through to normal routing.
 *
 * Reads the config, and only the config: CCFLARE_DISABLE_COMBO_SESSION_FALLBACK
 * is adopted into that config once at boot and never consulted again, so that
 * the dashboard switch is the answer rather than one opinion among two.
 *
 * A context without a config means there is no operator to ask — a caller or
 * test that never had one — and gets the historical looseness rather than the
 * new default, since nobody chose the new default for them.
 */
export function isComboSessionFallbackDisabled(ctx: ProxyContext): boolean {
	return !(ctx.config?.getComboSessionFallback?.() ?? true);
}

/**
 * Whether `account` should be excluded from routing for `model`'s family:
 * either its cached usage telemetry shows a fully exhausted (>=100%, future
 * reset) weekly_scoped cap for that family (origin "telemetry_confirmed"),
 * or the family was recently observed exhausted via an out_of_credits 429
 * (negative cache — origin as recorded by markFamilyExhausted, normally
 * "recent_upstream_rejection"). Telemetry is checked first: it's the
 * stronger signal and is what should surface if both happen to agree.
 */
function isAccountCapacityExcluded(
	account: Account,
	model: string,
	now: number,
): {
	excluded: boolean;
	resetAt: number | null;
	origin: FamilyExhaustionOrigin | null;
} {
	const family = getModelFamily(model);
	if (!family) return { excluded: false, resetAt: null, origin: null };

	const usageResult = isAccountExhaustedForModel(
		usageCache.get(account.id),
		model,
		now,
	);
	if (usageResult.exhausted) {
		return {
			excluded: true,
			resetAt: usageResult.resetAt,
			origin: "telemetry_confirmed",
		};
	}
	const negativeCacheOrigin = getFamilyExhaustionOrigin(
		account.id,
		family,
		now,
	);
	if (negativeCacheOrigin) {
		// Feed the cache expiry into the resetAt aggregation: a reactively
		// sidelined account becomes eligible again when its mark expires
		// (minutes), and Retry-After must reflect that instead of only the
		// far-away telemetry resets of other accounts.
		return {
			excluded: true,
			resetAt: getFamilyExhaustionUntil(account.id, family, now),
			origin: negativeCacheOrigin,
		};
	}
	return { excluded: false, resetAt: null, origin: null };
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
 * Gets accounts ordered by the load balancing strategy. Also returns the raw
 * (unfiltered) account list from the DB so callers that need to look past
 * the strategy's availability filter — e.g. distinguishing "no free capacity
 * anywhere" from "free capacity exists but is sidelined by a rate-limit
 * cooldown" — don't have to issue a second DB read.
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @param restrictions - The calling API key's account/provider allowlist, or
 *   null when the key is unrestricted, no key is in play (zero-keys mode), or
 *   the request is a verified internal probe. It arrives ALREADY exempted:
 *   `selectAccountsForRequest` resolves the probe exemption once, for every
 *   seam, and this function must not second-guess it.
 * @returns `ordered` — the strategy-filtered candidates; `all` — every account
 *   from the DB, unfiltered.
 */
export async function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
	restrictions?: ApiKeyRestrictions | null,
): Promise<{ ordered: Account[]; all: Account[] }> {
	try {
		const allAccounts = await ctx.dbOps.getAllAccounts();
		// Drop usage-capped accounts before the strategy ever sees them.
		//
		// This is the choke point that matters: every load-balancing strategy
		// filters with `isAccountAvailable(account, now)` and has no access to
		// the usage cache (it lives in this package, not @better-ccflare/
		// load-balancer), so gating inside the strategies would mean plumbing
		// usage through every one of them. Filtering here covers all strategies
		// at once and keeps a capped account from being picked, retried, and
		// model-cycled until every model 429s.
		//
		// The auto-refresh scheduler's probes must still get through: that is
		// how a capped account's window-reset is detected, and a capped account
		// is neither `paused` nor `rate_limited_until`, so nothing else would
		// let it back in.
		const isAutoRefreshBypass =
			meta.headers?.get("x-better-ccflare-bypass-session") === "true";
		// Deliberately narrow: this removes ONLY usage-capped accounts. The
		// paused / requires_reauth / rate_limited_until checks stay where they
		// already are, inside the strategies, because some of them rely on
		// seeing the full account list (session affinity has to find its sticky
		// account before deciding anything). Filtering those here too would
		// silently change strategy behaviour, which is not what this fix is for.
		const now = Date.now();
		const candidates = isAutoRefreshBypass
			? allAccounts
			: allAccounts.filter((account) => {
					const usage = usageSnapshot(account);
					return (
						usage === null ||
						!isUsageExhausted(
							usage.utilization,
							usage.resetMs,
							now,
							usage.extraUsageAvailable,
						)
					);
				});
		// `all` stays the raw, unfiltered DB read (not `candidates`) — the
		// cooldown-masking sweep in selectAccountsForRequest walks `all` to
		// find accounts sidelined only by a short rate-limit cooldown, and a
		// usage-capped account genuinely has no free capacity, so it must not
		// be mistaken for one of those "actually has capacity" accounts.
		// Provider is still determined dynamically per account downstream.
		//
		// Seam 1 — per-API-key account + provider allowlist.
		//
		// Same argument as the usage-cap filter above, and the reason this sits
		// here rather than inside the strategies: this is the only point where
		// the raw pool exists before any of the five strategies sees it, so one
		// insertion covers all of them. It must be BEFORE `ctx.strategy.select`
		// specifically — session affinity picks a sticky account from whatever
		// it is handed, and filtering afterwards would let it return an account
		// this key may not use (or, worse, return nothing while a permitted
		// account sat further down the list).
		const permitted = restrictsAccountPool(restrictions)
			? candidates.filter((account) =>
					isAccountAllowedForApiKey(account, restrictions),
				)
			: candidates;
		if (permitted.length !== candidates.length) {
			log.info(
				`API key restrictions: ${permitted.length}/${candidates.length} account(s) permitted for this key`,
			);
		}
		if (permitted.length === 0 && candidates.length > 0) {
			// The restriction, not capacity, emptied the pool. proxy.ts reads
			// this back to answer with a 403 policy refusal instead of the
			// generic pool_exhausted 503, which would advertise a Retry-After
			// for a condition no amount of waiting changes.
			setApiKeyRestrictionDenial(meta, {
				scope: summarizeAccountRestrictionScope(restrictions),
				removed: candidates.length,
			});
		}
		return {
			ordered: ctx.strategy.select(permitted, meta),
			all: allAccounts,
		};
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
		return { ordered: [], all: [] };
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
 * @param options - `restrictions` carries the calling API key's account /
 *   provider allowlist (null or absent = unrestricted, which is also what
 *   zero-keys mode and a key with all three columns NULL produce). `skipCombo`
 *   makes the combo lookup an explicit no-op —
 *   used by proxy.ts's Step-10 fallback re-selection after a combo's own
 *   slots have already been attempted and failed, so it falls straight into
 *   normal (capacity-filtered) routing instead of re-triggering the same
 *   combo lookup (which is keyed only on the model's family, not on
 *   `meta.comboName`, so clearing comboName alone would not prevent it).
 * @returns Array of selected accounts
 */
export async function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ProxyContext,
	model?: string,
	options?: {
		skipCombo?: boolean;
		restrictions?: ApiKeyRestrictions | null;
		familyComboOverrides?: Record<string, string> | null;
	},
): Promise<Account[]> {
	// Per-API-key restrictions, resolved ONCE here and reused by every
	// account-side seam below (the forced-account header, the combo slots, the
	// cooldown-masking sweep, and getOrderedAccounts's pool filter). One
	// resolution point means one place to audit the carve-outs:
	//
	//   - No key / an unrestricted key yields null, and every predicate is then
	//     a no-op. That covers zero-keys mode, where auth is disabled entirely
	//     and no key record exists to carry restrictions.
	//   - A VERIFIED internal probe yields null too. The auto-refresh and
	//     keepalive schedulers call the proxy with no API key at all, and a
	//     probe refused by a routing rule counts as a refresh failure — five of
	//     those pause a perfectly healthy account. Same exemption, same reason,
	//     as the forced-account model check and the usage-throttling bypass.
	//     `isInternalProbe` verifies the process-local probe secret, so a
	//     client that copies the marker header out of a log gets nothing.
	const keyRestrictions =
		options?.restrictions && !isInternalProbe(meta.headers, ctx)
			? options.restrictions
			: null;
	const poolRestricted = restrictsAccountPool(keyRestrictions);
	const isPermittedForKey = (account: Account): boolean =>
		isAccountAllowedForApiKey(account, keyRestrictions);

	// Check if a specific account is requested via special header
	if (meta.headers) {
		const forcedAccountId = meta.headers.get("x-better-ccflare-account-id");
		if (forcedAccountId) {
			// A verified internal auto-refresh probe — the secret-gated marker
			// the scheduler sends, never a header a client can set.
			const isInternalAutoRefreshProbe = isInternalProbe(
				meta.headers,
				ctx,
				"auto-refresh",
			);
			try {
				const allAccounts = await ctx.dbOps.getAllAccounts();
				const forcedAccount = allAccounts.find(
					(acc) => acc.id === forcedAccountId,
				);
				if (forcedAccount) {
					// Seam 2 — a restricted key must not name its way past its
					// own allowlist.
					//
					// This block returns [forcedAccount] without ever reaching
					// getOrderedAccounts, where the pool filter lives, so
					// without this check the header is a complete bypass: any
					// restricted key could name any account in the estate.
					//
					// Refusing — an empty selection, which proxy.ts answers as
					// api_key_account_restricted — rather than falling through
					// to normal selection, for exactly the reason the
					// force-account-model refusal below gives: falling through
					// would silently serve a DIFFERENT account than the header
					// named. Here it would also be pointless, since normal
					// selection applies the same filter.
					//
					// Internal probes are exempt by construction: keyRestrictions
					// is null for them (see the resolution at the top of this
					// function).
					if (poolRestricted && !isPermittedForKey(forcedAccount)) {
						log.warn(
							`API key restrictions: refusing forced account ${forcedAccount.name} — this key is limited to specific ${summarizeAccountRestrictionScope(keyRestrictions)}`,
						);
						setApiKeyRestrictionDenial(meta, {
							scope: "forced account",
							removed: 1,
							forcedAccountName: forcedAccount.name,
						});
						return [];
					}

					// With "force account model" on, a header naming an account
					// does not get to skip the one rule the setting exists for.
					//
					// Refusing here — an empty selection, which proxy.ts answers
					// as force_account_model_no_account — is deliberately not the
					// same as falling through to normal selection below: that
					// would send the request to a *different* account than the
					// header named, substituting the account to protect a rule
					// about models. Nor is it left to the provider's 400: an
					// unfiltered forced account also reaches the capacity
					// branches, which would advertise a `Retry-After` for an
					// account that can never serve this model no matter how long
					// the caller waits.
					//
					// Internal probes ARE exempted, and have to be. The
					// auto-refresh scheduler sends a compiled-in list of Claude
					// model ids to whatever account it is probing, so a Codex
					// account's own probe fails this check by construction —
					// and a probe answered with a refusal counts as a refresh
					// failure, which is how a perfectly healthy account would
					// end up paused with pause_reason='failure_threshold'.
					//
					// The exemption is keyed on `isInternalProbe`, which
					// verifies the internal probe secret, and not on the
					// bypass-session header a client can set. The probe is also
					// not a client asking for a model: it exists to touch the
					// endpoint and observe what comes back, so judging it by
					// what the caller "asked for" is a category error.
					if (
						model &&
						isForceAccountModelEnabled(ctx) &&
						!isInternalProbe(meta.headers, ctx) &&
						!accountServesModel(forcedAccount, model)
					) {
						log.warn(
							`Force account model: forced account ${forcedAccount.name} cannot serve "${model}" as requested — refusing rather than substituting the account or the model`,
						);
						return [];
					}

					// The auto-refresh scheduler sends dummy messages with x-better-ccflare-bypass-session
					// to intentionally refresh accounts that are paused due to auto_pause_on_overage,
					// or to probe accounts that are rate-limited (to detect when the window has reset).
					// For those requests we must allow through an overage-paused or rate-limited account
					// so the scheduler can hit the real endpoint and trigger the window-reset + auto-resume logic.
					// Only an overage pause qualifies for the bypass header: a manual pause
					// (pause_reason='manual') or a peak_hours pause must still win even when the
					// overage feature flag is enabled, because the auto-resume guard would never
					// un-pause those accounts. This mirrors the scheduler eligibility query and the
					// sendDummyMessage resume guard
					// (auto_pause_on_overage_enabled=1 AND pause_reason IN (NULL,'overage')).
					//
					// A failure_threshold pause is the one exception, and only for a
					// secret-verified auto-refresh probe. The scheduler's eligibility SQL
					// deliberately keeps re-probing those accounts (every 10 min) so a
					// transiently broken account can prove itself healthy again and be
					// auto-resumed (#262) — a probe that never reaches the account it names
					// can never do that. The bypass header alone must NOT unlock it: only
					// the scheduler holds the process-local probe secret.
					const isAutoRefreshBypass =
						meta.headers.get("x-better-ccflare-bypass-session") === "true";
					const forcedUsage = usageSnapshot(forcedAccount);
					const available = isAccountAvailable(
						forcedAccount,
						Date.now(),
						forcedUsage ?? undefined,
					);
					const isOveragePaused =
						forcedAccount.paused &&
						forcedAccount.auto_pause_on_overage_enabled &&
						(!forcedAccount.pause_reason ||
							forcedAccount.pause_reason === "overage");
					const isRateLimited =
						!available &&
						!forcedAccount.paused &&
						!!forcedAccount.rate_limited_until;
					// A usage-capped account is neither paused nor
					// rate_limited_until, so without this it would fail
					// `available` and then match none of the bypass conditions —
					// leaving the scheduler unable to probe it and detect its
					// window reset, the one thing the bypass exists to do.
					const isUsageCapped =
						!available &&
						!forcedAccount.paused &&
						!forcedAccount.rate_limited_until &&
						forcedUsage !== null;
					const isFailureThresholdPaused =
						!!forcedAccount.paused &&
						forcedAccount.pause_reason === "failure_threshold";
					const allowThrough =
						available ||
						(isAutoRefreshBypass &&
							!forcedAccount.requires_reauth &&
							(isOveragePaused || isRateLimited || isUsageCapped)) ||
						(isInternalAutoRefreshProbe &&
							!forcedAccount.requires_reauth &&
							isFailureThresholdPaused);
					if (allowThrough) {
						return [forcedAccount];
					}
					// A probe is a question about one named account, so it must
					// never be answered by a different one. Falling through to
					// normal selection here would send the dummy message to a
					// healthy account, and the 200 it returns is read by the
					// scheduler as "this account is fine": it logs the refresh as
					// sent, auto-resumes the named account and clears its
					// rate_limited_until while that account is still exhausted —
					// while quietly spending a real request on the substitute
					// (probe traffic is not written to `requests`, so the cost is
					// invisible). Refusing yields an empty selection, which
					// proxy.ts answers as pool_exhausted (503) and the scheduler
					// counts as the failed probe it actually was.
					if (isInternalAutoRefreshProbe) {
						log.warn(
							`Auto-refresh probe for ${forcedAccount.name} (${forcedAccount.id}) refused rather than routed to another account (paused=${!!forcedAccount.paused}, pause_reason=${forcedAccount.pause_reason ?? "none"}, rate_limited_until=${forcedAccount.rate_limited_until ?? "none"}, requires_reauth=${!!forcedAccount.requires_reauth})`,
						);
						return [];
					}
				} else if (isInternalAutoRefreshProbe) {
					// Same rule for an id that matches nothing: probing some other
					// account would report a success for an account that is gone.
					log.warn(
						`Auto-refresh probe names account ${forcedAccountId}, which no longer exists — refusing rather than probing a different account`,
					);
					return [];
				}
				// If forced account not found or unavailable (paused/rate-limited), ordinary
				// client traffic falls back to normal selection (probes returned above)
			} catch (error) {
				log.error(
					"Failed to get accounts from database for forced account lookup:",
					error,
				);
				// The invariant holds even when the lookup is what broke: normal
				// selection below would hand the probe to whichever account is
				// healthy, and its 200 would be recorded as a success for the
				// account named here — which this code never managed to read.
				// A failed probe is the honest outcome of a failed lookup.
				if (isInternalAutoRefreshProbe) {
					log.warn(
						`Auto-refresh probe for account ${forcedAccountId} refused: the account lookup failed, and falling back to normal selection would probe a different account`,
					);
					return [];
				}
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

	/**
	 * Whether `account`'s provider is excluded for this request. Split out of
	 * `applyExclusions` so a caller can test membership WITHOUT emitting that
	 * function's warning: the warning counts the list it was handed, and the
	 * combo path hands it the whole fleet while caring only about the slots it
	 * actually skips.
	 */
	const isProviderExcluded = (a: Account): boolean => {
		for (const ex of excludeProviders) {
			// "anthropic-oauth" targets only Anthropic OAuth accounts (refresh_token present),
			// leaving Anthropic API key accounts (console mode) eligible.
			if (ex === "anthropic-oauth") {
				if (a.provider === "anthropic" && a.refresh_token != null) return true;
			} else if (a.provider === ex) {
				return true;
			}
		}
		return false;
	};

	const applyExclusions = (accounts: Account[]): Account[] => {
		if (excludeProviders.length === 0) return accounts;
		const filtered = accounts.filter((a) => !isProviderExcluded(a));
		const skipped = accounts.length - filtered.length;
		if (skipped > 0) {
			log.warn(
				`Skipping ${skipped} account(s) excluded for this request type (Codex CLI traffic must not use Anthropic OAuth accounts)`,
			);
		}
		return filtered;
	};

	// Try combo-aware routing if a model is provided. Skipped entirely when
	// skipCombo is set (see the `options` doc above), when combos are switched
	// off, and when the model is forced: a combo slot exists to send a
	// different model than the one asked for, which is the one thing that
	// setting forbids.
	if (
		model &&
		!options?.skipCombo &&
		areCombosEnabled(ctx) &&
		!isForceAccountModelEnabled(ctx)
	) {
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
				const overrideId = !isInternalProbe(meta.headers, ctx)
					? options?.familyComboOverrides?.[family]
					: undefined;
				const override = overrideId
					? await ctx.dbOps.getCombo(overrideId)
					: null;
				const combo = overrideId
					? override?.enabled
						? { ...override, slots: await ctx.dbOps.getComboSlots(overrideId) }
						: null
					: await ctx.dbOps.getActiveComboForFamily(family as ComboFamily);

				if (!combo) {
					// Without this line the detour is silent: a family with no active
					// combo falls into normal pool routing and can be served by any
					// provider, with nothing in the log to say so.
					log.info(
						`No active combo for family ${family} - falling back to normal routing`,
					);
				}
				if (combo) {
					const passthroughSlots = combo.slots.filter(
						(s) => !s.model || s.model.trim().length === 0,
					).length;
					log.info(
						`Combo routing active: ${combo.name} for family ${family} (${combo.slots.length} slots, ${passthroughSlots} passthrough)`,
					);

					const allAccounts = await ctx.dbOps.getAllAccounts();
					const accountMap = new Map<string, Account>();
					for (const account of allAccounts) {
						accountMap.set(account.id, account);
					}

					// Provider exclusions are resolved ONCE up front and each
					// candidate is checked against them before it is pushed into the
					// slot list, so an excluded slot never reaches slotEntries:
					// `slots` and the returned accounts stay index-aligned by
					// construction, which proxy.ts relies on when it pairs
					// accounts[i] with slots[i].
					//
					// Built from the predicate rather than `applyExclusions`: that
					// function warns about everything it filtered, and `accountMap`
					// is the whole fleet, so using it here would log exclusions for
					// accounts that were never combo candidates. The slots actually
					// skipped are counted in the loop and logged once after it.
					const permittedAccountIds = new Set(
						[...accountMap.values()]
							.filter((a) => !isProviderExcluded(a))
							.map((a) => a.id),
					);
					let excludedSlots = 0;
					const availableAccounts: Account[] = [];
					const slotEntries: Array<{
						accountId: string;
						modelOverride: string;
					}> = [];
					const capacityRoutingEnabled = isCapacityRoutingEnabled(ctx);
					const capacityNow = Date.now();

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

						if (
							!isAccountAvailable(
								account,
								Date.now(),
								usageSnapshot(account) ?? undefined,
							)
						) {
							continue;
						}

						// Seam 3 — combo slots read getAllAccounts() directly and
						// never call getOrderedAccounts, so seam 1 does not cover
						// them. A combo whose slots name accounts outside the
						// key's allowlist would otherwise route straight past it.
						// Dropping the slot (rather than refusing outright) is
						// deliberate: a combo is a routing preference, and the
						// remaining permitted slots — or the SessionStrategy
						// fallthrough below, which re-applies seam 1 — are still
						// legitimate ways to serve this key.
						if (poolRestricted && !isPermittedForKey(account)) {
							continue;
						}

						// A 429 only cools the (account, model) pair it hit — the
						// account stays eligible for its other combo slots. The slot's
						// effective upstream model is the one that cools: a passthrough
						// slot (empty model) sends the request's own model.
						const slotModel = slot.model?.trim() ? slot.model : model;
						const cooldownUntil = slotModel
							? getModelCooldownUntil(account.id, slotModel)
							: null;
						if (cooldownUntil !== null) {
							log.info(
								`Combo slot ${account.name}/${slotModel} for ${combo.name} is in a model-scoped cooldown until ${new Date(cooldownUntil).toISOString()} — skipping (account stays eligible for its other slots)`,
							);
							continue;
						}

						// Per-slot capacity check uses the slot's own model override
						// (not the combo family's request model), since slots can carry
						// distinct concrete models within the same family.
						if (
							capacityRoutingEnabled &&
							isAccountCapacityExcluded(
								account,
								// Passthrough slots (empty model) carry no model of their
								// own: fall back to the request's model, otherwise
								// getModelFamily("") returns null and this filter would
								// silently no-op for those slots.
								slot.model || model,
								capacityNow,
							).excluded
						) {
							continue;
						}

						// Membership check against the exclusion set resolved once
						// above (a per-slot `applyExclusions` call would repeat its
						// warning once per slot).
						if (!permittedAccountIds.has(account.id)) {
							excludedSlots++;
							continue;
						}

						availableAccounts.push(account);
						slotEntries.push({
							accountId: slot.account_id,
							modelOverride: slot.model,
						});
					}

					if (excludedSlots > 0) {
						log.warn(
							`Skipping ${excludedSlots} combo slot(s) whose account is excluded for this request type (Codex CLI traffic must not use Anthropic OAuth accounts)`,
						);
					}

					// `definitionSlots` is the stable combo definition — every ENABLED
					// slot — so the deferral diff below can see the slots this request
					// could not route, and so an account's sibling-model check survives
					// its own slots cooling down. Hoisted above the routable check
					// because that diff has to run on every exit from this branch. The
					// combo STATE is deliberately NOT hoisted with it; see the branch.
					const definitionSlots = combo.slots
						.filter((s) => s.enabled)
						.map((s) => ({
							accountId: s.account_id,
							modelOverride: s.model,
						}));

					/**
					 * Record the definition slots this request could not route as
					 * deferred vision candidates — the combo counterpart of
					 * `notePoolDeferrals` below.
					 *
					 * Recorded HERE rather than in proxy.ts, which until now computed
					 * `definitionSlots` minus the routable slots with no eligibility
					 * filter: the combo loop there has only (accountId,
					 * modelOverride) per slot, no `Account` row, so one manually
					 * paused or dead-token slot was indistinguishable from a cooling
					 * one and held the terminal vision verdict open forever — a
					 * combo whose every USABLE slot refuses an image answered a
					 * retryable 503 instead of the permanent 400. Same defect the
					 * pool path was fixed for, on the path that was missed. Moving
					 * the recording here gives both the filter and the account rows
					 * for free — `allAccounts` and the dropping code already live in
					 * this function — without adding a DB read to proxy.ts's
					 * per-request path, which is what a `getAllAccounts()` there
					 * would have cost.
					 *
					 * A dropped slot is deferred unless it is out for good, by the
					 * same rules the pool path applies:
					 * - header-excluded providers
					 *   (`x-better-ccflare-exclude-providers`) are permanently
					 *   ineligible for THIS request, not deferred;
					 * - an indefinite hold-out — see `isIndefinitelyHeldOut` —
					 *   returns only by operator action, so waiting cannot rescue
					 *   the request.
					 * "Force account model" cannot apply here: combo routing is
					 * skipped entirely when that setting is on, so every slot's
					 * account was already free to serve the slot's pin.
					 *
					 * A slot whose account is GONE from the fleet (the "references
					 * unknown account" drop above) has no row to filter on and stays
					 * deferred: its capability is unknowable, and the conservative
					 * retryable answer is the honest one for a broken combo.
					 *
					 * Runs on EVERY exit from this branch, before the routable
					 * check below, so the two fall-throughs — session fallback
					 * disabled, and the SessionStrategy fallback — carry the record
					 * too. With no routable slot every definition slot is deferred
					 * (minus the ineligible ones), which is what keeps the terminal
					 * vision verdict from treating a pool refusal as permanent when
					 * every combo pin was merely cooling.
					 */
					const routableSlots = new Set(
						slotEntries.map(
							(entry) => `${entry.accountId}\u0000${entry.modelOverride ?? ""}`,
						),
					);
					const deferredComboSlots: DeferredVisionCandidate[] = [];
					for (const definitionSlot of definitionSlots) {
						if (
							routableSlots.has(
								`${definitionSlot.accountId}\u0000${definitionSlot.modelOverride ?? ""}`,
							)
						) {
							continue;
						}
						const account = accountMap.get(definitionSlot.accountId);
						// Eligibility is tested against `permittedAccountIds` and the account
						// row directly, NOT against a set collected in the loop above: that
						// loop drops a slot for unavailability, cooldown or capacity BEFORE it
						// checks the exclusion, so an excluded-AND-cooling slot would never be
						// recorded there and would be deferred as merely temporary — holding the
						// terminal vision verdict open for a route that is permanently
						// ineligible for this request. The permit set is computed from the whole
						// fleet before the loop, so it answers "eligible for this request at
						// all" whatever else dropped the slot. Exclusion outranks cooldown here:
						// a cooldown ends, an exclusion for this request does not.
						// An account outside this API key's allowlist is just as
						// permanently ineligible as a header-excluded one.
						if (
							account &&
							(!permittedAccountIds.has(account.id) ||
								isIndefinitelyHeldOut(account) ||
								(poolRestricted && !isPermittedForKey(account)))
						) {
							continue;
						}
						deferredComboSlots.push({
							accountId: definitionSlot.accountId,
							modelOverride: definitionSlot.modelOverride,
						});
					}
					addDeferredCandidates(meta, deferredComboSlots);

					if (availableAccounts.length > 0) {
						// Only mark this request as combo-routed once combo accounts are
						// actually being returned. Setting it on a fall-through leaves
						// stale combo state on `meta` for what downstream treats as
						// ordinary, non-combo selection, and that state is not cosmetic:
						// proxy.ts resolves model pins from it BY POSITION and reads
						// `comboName` to decide whether a terminal upstream error is
						// forwarded to the client or discarded for failover. The
						// deferred-slot recording above is the part that must run on
						// every exit; this is not. (The fallback-disabled exit below
						// sets its own info, with `slots: []`.)
						//
						// `slots` is the per-request routable subset and MUST stay
						// index-aligned with the returned accounts: the same length,
						// with slots[i].accountId === returned[i].id.
						const slotInfo: ComboSlotInfo = {
							comboName: combo.name,
							slots: slotEntries,
							definitionSlots,
						};
						setComboSlotInfo(meta, slotInfo);
						meta.comboName = combo.name;

						// Already exclusion-filtered inside the loop, so this is
						// index-aligned with `slots`.
						return availableAccounts;
					}

					// All slots unavailable — fall back to normal routing. Combo state
					// is deliberately left unset so this fallthrough is treated as
					// ordinary, non-combo selection downstream.
					if (isComboSessionFallbackDisabled(ctx)) {
						setComboSlotInfo(meta, {
							comboName: combo.name,
							slots: [],
							// Even with no routable slots this request, keep the
							// stable definition so a 429 can still prove the
							// account has a sibling-model slot.
							definitionSlots: combo.slots
								.filter((s) => s.enabled)
								.map((s) => ({
									accountId: s.account_id,
									modelOverride: s.model,
								})),
						});
						meta.comboName = combo.name;
						log.warn(
							`All ${combo.slots.length} combo slots unavailable for ${combo.name}, session fallback disabled by the Combo Session Fallback setting (Settings → Advanced)`,
						);
						return [];
					}

					log.warn(
						`All ${combo.slots.length} combo slots unavailable for ${combo.name}, falling back to SessionStrategy`,
					);
				}
			}
		}
	}

	const { ordered: rawOrderedAccounts, all: allAccounts } =
		await getOrderedAccounts(meta, ctx, keyRestrictions);
	let orderedAccounts = applyExclusions(rawOrderedAccounts);

	// "Force account model": keep only accounts that can serve the requested
	// model as written. Nothing downstream will rename it, so an account that
	// would need a translation is not a candidate — and if that empties the
	// list, the request fails rather than being served a model nobody asked
	// for. Switching accounts is still fine; switching models is not.
	if (model && isForceAccountModelEnabled(ctx)) {
		const before = orderedAccounts.length;
		orderedAccounts = orderedAccounts.filter((account) =>
			accountServesModel(account, model),
		);
		if (orderedAccounts.length !== before) {
			log.info(
				`Force account model: ${orderedAccounts.length}/${before} account(s) can serve "${model}" as requested`,
			);
		}
	}

	/**
	 * Records the accounts this selection dropped but that could route again
	 * later, so proxy.ts's terminal vision verdict cannot claim a permanence the
	 * fleet has not earned.
	 *
	 * The universe is `allAccounts` — the raw DB read — minus the two drops that
	 * are permanent FOR THIS REQUEST and therefore are not deferrals: the
	 * providers the client excluded with `x-better-ccflare-exclude-providers`, and
	 * an account that cannot serve the requested model as written while "force
	 * account model" forbids substituting one. Neither can ever answer this
	 * request however long the client waits, so neither can rescue it.
	 *
	 * Everything else missing from `selected` is a deferral. That is computed as a
	 * set difference rather than a per-reason list on purpose. Some of the drops
	 * happen in this file (the usage-cap pre-filter in getOrderedAccounts, the
	 * model-scoped capacity filter below) but the availability drop — paused,
	 * rate_limited_until, requires_reauth — happens inside
	 * `ctx.strategy.select()`, in the load-balancer package, where this function
	 * cannot see it. Enumerating only the local reasons would repeat exactly the
	 * mistake that got the first attempt at the verdict reverted (e64e7f13):
	 * computing permanence from the candidates that survived selection instead of
	 * the candidates that were eligible.
	 *
	 * Deliberately conservative about what counts as eligible. An auto-resuming
	 * pause (overage, peak-hours, failure-threshold) is recorded as deferred:
	 * the account returns to rotation by itself with the image unchanged, so it
	 * must hold the verdict open. A MANUAL pause and a `requires_reauth` account
	 * are filtered out before recording instead — see the comment on the filter
	 * below.
	 *
	 * Only called on the paths that return a non-empty selection: an empty one
	 * makes proxy.ts answer at its Step 7 (model-family exhaustion, usage
	 * throttling, pool_exhausted) before any candidate loop runs, so the verdict
	 * that reads this list is never reached.
	 */
	const notePoolDeferrals = (selected: Account[]): void => {
		// Every filter between `allAccounts` and `selected` only ever removes, so
		// equal lengths means nothing was dropped. That is the healthy-fleet case
		// and this runs on the selection path of every request, so it returns
		// before allocating anything.
		if (selected.length === allAccounts.length) return;

		const selectedIds = new Set(selected.map((account) => account.id));
		const forcedModel = model && isForceAccountModelEnabled(ctx) ? model : null;
		const deferred = applyExclusions(allAccounts)
			.filter((account) => !selectedIds.has(account.id))
			// An operator's hold-out, not a deferral: see
			// {@link isIndefinitelyHeldOut}, shared with the combo-slot recording
			// below so the two paths cannot drift.
			.filter((account) => !isIndefinitelyHeldOut(account))
			// Outside this API key's allowlist: permanently ineligible for the
			// request, never a deferral.
			.filter((account) => !poolRestricted || isPermittedForKey(account))
			.filter(
				(account) =>
					forcedModel === null || accountServesModel(account, forcedModel),
			)
			// null, not `model`: the cache key is the request body's own model
			// string, which an agent-preference rewrite can make differ from the
			// routing model. proxy.ts resolves null against the body so the key
			// matches the one a refusal would have been written under.
			.map((account) => ({ accountId: account.id, modelOverride: null }));
		addDeferredCandidates(meta, deferred);
	};

	// Model-scoped capacity filter for the non-combo (or combo-inactive/
	// combo-exhausted-fallthrough) path: drop accounts whose weekly per-model
	// cap for this model's family is exhausted. Only when the filter empties
	// an otherwise non-empty candidate list do we record exhaustion info —
	// an empty candidate list from the strategy itself is the ordinary
	// pool_exhausted case and must not be relabeled.
	if (model && isCapacityRoutingEnabled(ctx)) {
		const family = getModelFamily(model);
		if (family) {
			const now = Date.now();
			const available: Account[] = [];
			let earliestResetAt: number | null = null;
			let anyExcluded = false;
			// Strictest origin wins: the aggregate is only "telemetry_confirmed"
			// when EVERY excluded account was telemetry-confirmed; a single
			// reactive-only exclusion downgrades the whole response to neutral
			// wording, since that account's exhaustion was never corroborated.
			let allTelemetryConfirmed = true;

			for (const account of orderedAccounts) {
				const { excluded, resetAt, origin } = isAccountCapacityExcluded(
					account,
					model,
					now,
				);
				if (excluded) {
					anyExcluded = true;
					if (origin !== "telemetry_confirmed") {
						allTelemetryConfirmed = false;
					}
					if (
						resetAt != null &&
						(earliestResetAt == null || resetAt < earliestResetAt)
					) {
						earliestResetAt = resetAt;
					}
					continue;
				}
				available.push(account);
			}

			if (available.length === 0 && anyExcluded) {
				// Every SURVIVING candidate is capacity-exhausted, but
				// orderedAccounts has already been through the strategy's
				// isAccountAvailable filter, which silently drops any account
				// with a future rate_limited_until regardless of the reason
				// (a short rate-limit cooldown included) — those accounts
				// never reached the loop above. If any of them still has free
				// capacity for this family, the weekly cap is not the real
				// blocker: the account is only sidelined for minutes, and the
				// response must say so instead of asserting weekly exhaustion.
				//
				// allAccounts is the raw, unfiltered DB read — it still
				// contains accounts excluded for this request via
				// x-better-ccflare-exclude-providers (e.g. Anthropic OAuth
				// accounts excluded for Codex CLI traffic). Re-run the same
				// exclusion the candidate list already went through so a
				// header-excluded account — permanently ineligible for this
				// request, not just cooling down — can never be reported as
				// the "true blocker" with its cooldown as Retry-After.
				const orderedIds = new Set(orderedAccounts.map((a) => a.id));
				// Seam 4 — the same argument, one step further. An account this
				// API key may not use is permanently ineligible for this
				// request, not "sidelined for minutes", so reporting it as the
				// true blocker would hand the caller a Retry-After for an
				// account that will never serve them.
				const sweepBase = applyExclusions(allAccounts);
				const sweepCandidates = poolRestricted
					? sweepBase.filter(isPermittedForKey)
					: sweepBase;
				let earliestCooldownResetAt: number | null = null;
				for (const account of sweepCandidates) {
					if (orderedIds.has(account.id)) continue;
					if (account.paused || account.requires_reauth) continue;
					if (
						account.rate_limited_until == null ||
						account.rate_limited_until <= now
					) {
						continue;
					}
					if (isAccountCapacityExcluded(account, model, now).excluded) {
						continue;
					}
					if (
						earliestCooldownResetAt == null ||
						account.rate_limited_until < earliestCooldownResetAt
					) {
						earliestCooldownResetAt = account.rate_limited_until;
					}
				}

				if (earliestCooldownResetAt != null) {
					log.warn(
						`Model family "${family}" not actually capacity-exhausted — an account with free capacity is only sidelined by a rate-limit cooldown until ${new Date(earliestCooldownResetAt).toISOString()}`,
					);
					setModelFamilyExhaustionInfo(meta, {
						family,
						resetAt: earliestCooldownResetAt,
						origin: "cooldown_masked",
					});
					return [];
				}

				log.warn(
					`All ${orderedAccounts.length} candidate account(s) exhausted for model family "${family}"`,
				);
				setModelFamilyExhaustionInfo(meta, {
					family,
					resetAt: earliestResetAt,
					origin: allTelemetryConfirmed
						? "telemetry_confirmed"
						: "recent_upstream_rejection",
				});
				return [];
			}
			notePoolDeferrals(available);
			return applyXaiCacheAffinity(available, meta);
		}
	}

	notePoolDeferrals(orderedAccounts);
	return applyXaiCacheAffinity(orderedAccounts, meta);
}
