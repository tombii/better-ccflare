/**
 * Per-(account, model) cache of upstreams that refused image input.
 *
 * better-ccflare has no vision capability data for the gateways it fronts, so
 * it forwards Anthropic `image` blocks to every account and fails over when an
 * upstream answers a 400 saying the model cannot accept image input (see
 * `isVisionUnsupportedError` / `requestCarriesImageContent` in
 * proxy-operations.ts). That contract is correct but expensive: each blind
 * (account, model) pair costs a full upstream round-trip — the converted
 * request body uploaded, then drained — on EVERY image request, and a combo
 * can hold a dozen slots, so one image request can burn a dozen round-trips
 * before landing somewhere that serves it. This store remembers the pairs that
 * already said no, so routing can skip them without a request.
 *
 * Design decisions, all deliberate:
 *
 * 1. **In-memory only — no database, no migrations.** Every migration in this
 *    repo has to be ported to both the SQLite and the PostgreSQL schema, so a
 *    new table or column is expensive; capability data is ephemeral anyway. A
 *    gateway can gain vision support (a model swap behind the same id, an
 *    upstream release), and a stale persisted "no" would keep a working route
 *    out of rotation long after the TTL that would have expired it in memory.
 *    Losing the store on restart costs one re-learn round-trip per blind pair.
 * 2. **The key is the pair (accountId, model).** Not the account alone: the
 *    same model id served by a different gateway can behave differently, so an
 *    account-level "no vision" would sideline routes that work. Not the combo
 *    slot either: slots already pin an (account, model) pair, so the same key
 *    covers combo routing and pool routing with one store.
 * 3. **Model and account strings are trimmed before use.** Callers hand in
 *    model ids from config and request bodies, where stray whitespace is
 *    common and would otherwise create a second entry for the same route. An
 *    empty or whitespace-only model / accountId is a no-op on write and reads
 *    back as `false`: an entry keyed on an empty model would say "this account
 *    refuses images for nothing in particular" and could suppress every route.
 *    The routing suffix a model id can carry (`model {"only":["provider"]}`) is
 *    deliberately NOT stripped here — unlike the 429 cooldown in
 *    model-cooldown.ts, which is about one account's quota regardless of which
 *    provider served it, vision support belongs to the upstream that actually
 *    answered, and the suffix chooses that upstream.
 * 4. **Bounded.** At most {@link MAX_VISION_CAPABILITY_ENTRIES} entries; once
 *    full, the oldest-learned entry is evicted to make room. A large fleet
 *    (many accounts × many model ids) must not be able to grow the map without
 *    limit, and the oldest entry is the one most likely to be stale. Both the
 *    eviction and the snapshot order by `learnedAt` explicitly rather than
 *    trusting map insertion order, so a caller whose clock went backwards
 *    cannot change which entry gets dropped; ties go to the entry inserted
 *    first.
 * 5. **No background timer.** Entries expire by comparing `learnedAt` against
 *    the TTL and are dropped lazily: on read, on snapshot, and by a prune pass
 *    on write. A `setInterval` sweep would keep the process alive after the
 *    last request and would leak across test files, for no benefit over
 *    expiring on access.
 *
 * This module is a store only: it neither classifies an upstream response nor
 * skips a route. The request path consumes it separately.
 */

/** Env override for {@link DEFAULT_VISION_CAPABILITY_TTL_MS}. */
const TTL_ENV_VAR = "CCFLARE_VISION_CAPABILITY_TTL_MS";

/**
 * Compiled-in TTL: 12 hours. Long enough that a fleet of image-heavy clients
 * pays the re-learn round-trip at most twice a day per blind pair, short
 * enough that a gateway which gains vision support comes back into rotation on
 * its own without an operator having to clear anything.
 */
export const DEFAULT_VISION_CAPABILITY_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Hard cap on distinct (account, model) entries. Once reached, the entry with
 * the oldest `learnedAt` is evicted — see constraint 4 in the module docs.
 */
export const MAX_VISION_CAPABILITY_ENTRIES = 512;

/** One learned refusal, as reported by {@link visionCapabilitySnapshot}. */
export interface VisionCapabilityEntry {
	accountId: string;
	/** Trimmed model id, including any routing suffix the caller used. */
	model: string;
	/** Epoch ms at which the upstream's refusal was recorded. */
	learnedAt: number;
}

/**
 * Resolves the TTL in effect, reading `CCFLARE_VISION_CAPABILITY_TTL_MS` on
 * every call. Validation mirrors `readDurationOverrideMs` in
 * packages/core/src/constants.ts (which is not exported): anything that is not
 * a positive finite number — unset, empty, `0`, negative, `NaN`, non-numeric —
 * falls back to {@link DEFAULT_VISION_CAPABILITY_TTL_MS} rather than disabling
 * expiry or expiring everything immediately.
 */
export function visionCapabilityTtlMs(): number {
	const parsed = Number(process.env[TTL_ENV_VAR]);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_VISION_CAPABILITY_TTL_MS;
}

/**
 * The TTL resolved when this module was loaded: the override from
 * `CCFLARE_VISION_CAPABILITY_TTL_MS` when it is a positive finite number,
 * otherwise {@link DEFAULT_VISION_CAPABILITY_TTL_MS}. Exported for log lines
 * and the debug surface; code that applies the TTL should call
 * {@link visionCapabilityTtlMs} so a change to the environment is picked up.
 */
export const VISION_CAPABILITY_TTL_MS = visionCapabilityTtlMs();

/**
 * The store. The value repeats the key's two halves so the snapshot never has
 * to parse a key back apart.
 */
const entries = new Map<string, VisionCapabilityEntry>();

/**
 * Account ids are UUIDs (see the `INSERT INTO accounts` call sites), so they
 * contain no colon and the first `:` is unambiguously the separator — the same
 * key shape model-cooldown.ts uses.
 */
function entryKey(accountId: string, model: string): string {
	return `${accountId}:${model}`;
}

/**
 * Trims both halves and answers `null` when either is blank, so the no-op rule
 * (constraint 3) is decided in one place instead of per function.
 */
function normalizePair(
	accountId: string,
	model: string,
): { accountId: string; model: string } | null {
	const trimmedAccount = accountId.trim();
	const trimmedModel = model.trim();
	if (!trimmedAccount || !trimmedModel) return null;
	return { accountId: trimmedAccount, model: trimmedModel };
}

/**
 * Drops every entry whose age has reached `ttl`. Called on write so expired
 * entries stop occupying slots in the cap; expiry itself is `age >= ttl`, the
 * same inclusive boundary `isModelCooling` uses for `until <= now`.
 */
function pruneExpired(now: number, ttl: number): void {
	for (const [key, entry] of entries) {
		if (now - entry.learnedAt >= ttl) entries.delete(key);
	}
}

/**
 * Drops the entry with the oldest `learnedAt` (the first inserted, on a tie).
 * A scan rather than "delete the map's first key": learned order and insertion
 * order coincide for wall-clock callers, but only the scan still picks the
 * oldest-learned entry if a caller's `now` ever goes backwards.
 */
function evictOldest(): void {
	let oldestKey: string | undefined;
	let oldestLearnedAt = Number.POSITIVE_INFINITY;
	for (const [key, entry] of entries) {
		if (entry.learnedAt < oldestLearnedAt) {
			oldestLearnedAt = entry.learnedAt;
			oldestKey = key;
		}
	}
	if (oldestKey !== undefined) entries.delete(oldestKey);
}

/**
 * Records that the account's upstream refused image input for this model, so
 * routing can skip the pair until the entry expires. A blank model or
 * accountId is a no-op. Prunes expired entries first, then evicts
 * oldest-learned-first if the store is still at its cap.
 */
export function markVisionUnsupported(
	accountId: string,
	model: string,
	now: number = Date.now(),
): void {
	const pair = normalizePair(accountId, model);
	if (!pair) return;

	const ttl = visionCapabilityTtlMs();
	pruneExpired(now, ttl);

	// Delete first so re-marking a pair that is already stored cannot push the
	// size over the cap and evict an unrelated entry.
	const key = entryKey(pair.accountId, pair.model);
	entries.delete(key);
	while (entries.size >= MAX_VISION_CAPABILITY_ENTRIES) {
		const sizeBeforeEviction = entries.size;
		evictOldest();
		// Defensive: only reachable if the map is somehow empty at the cap.
		if (entries.size === sizeBeforeEviction) break;
	}
	entries.set(key, { ...pair, learnedAt: now });
}

/**
 * Whether this (account, model) pair is known to refuse image input and the
 * entry has not expired yet. False for a pair never marked, for a blank model
 * or accountId, and once the entry's age reaches the TTL — an expired entry is
 * deleted on read, matching the negative caches in model-cooldown.ts and
 * model-capacity.ts.
 */
export function isVisionUnsupported(
	accountId: string,
	model: string,
	now: number = Date.now(),
): boolean {
	const pair = normalizePair(accountId, model);
	if (!pair) return false;

	const key = entryKey(pair.accountId, pair.model);
	const entry = entries.get(key);
	if (!entry) return false;
	if (now - entry.learnedAt >= visionCapabilityTtlMs()) {
		entries.delete(key);
		return false;
	}
	return true;
}

/**
 * Invalidates learned refusals.
 *
 * - No argument: drops every entry. Use after a bulk change to the fleet, or
 *   to force a re-probe of every route.
 * - An accountId: drops only that account's entries, for an account whose
 *   credentials, endpoint or model list just changed — the refusals were
 *   learned against the old configuration. Keyed as `accountId:model`, so this
 *   is a prefix scan rather than a single delete.
 *
 * Entries also expire on their own via the TTL; this makes invalidation
 * proactive. An empty or whitespace-only accountId is a no-op (it cannot name
 * a stored entry) and in particular does NOT clear everything — only an
 * omitted argument does.
 */
export function clearVisionCapability(accountId?: string): void {
	if (accountId === undefined) {
		entries.clear();
		return;
	}
	const trimmedAccount = accountId.trim();
	if (!trimmedAccount) return;

	const prefix = `${trimmedAccount}:`;
	for (const key of entries.keys()) {
		if (key.startsWith(prefix)) entries.delete(key);
	}
}

/**
 * The unexpired entries, oldest-learned first (insertion order on a tie), for a
 * debug surface to show which routes are currently being skipped and why.
 * Expired entries are dropped as the snapshot is built and are excluded from
 * it. The returned objects are copies, so a caller cannot mutate the store.
 */
export function visionCapabilitySnapshot(
	now: number = Date.now(),
): VisionCapabilityEntry[] {
	const ttl = visionCapabilityTtlMs();
	const snapshot: VisionCapabilityEntry[] = [];
	for (const [key, entry] of entries) {
		if (now - entry.learnedAt >= ttl) {
			entries.delete(key);
			continue;
		}
		snapshot.push({ ...entry });
	}
	// `Array.prototype.sort` is stable, so entries sharing a `learnedAt` keep
	// their insertion order.
	return snapshot.sort((a, b) => a.learnedAt - b.learnedAt);
}
