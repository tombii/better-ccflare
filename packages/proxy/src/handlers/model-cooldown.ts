import {
	computeWindowless429CooldownMs,
	stripModelRouting,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";

/**
 * Per-(account, upstream model) cooldown store for combos and ordinary requests.
 *
 * Combos route one request through ordered (account, model) slots. A 429 from
 * ONE slot says nothing about the account's other slots — a free model whose
 * daily quota died must not block the paid model slot on the same account.
 * The documented semantics of `model_fallback_429` are per-model for exactly
 * this reason (see packages/types/src/rate-limit-reason.ts): "the account can
 * still serve other models via client-side fallback". An account-wide
 * `rate_limited_until` bench would contradict that and sideline every other
 * slot on the account, so combo routing needs a cooldown keyed by the
 * (account, model) pair itself.
 *
 * The store is intentionally process-local. Losing it on restart is safe:
 * the first request to the recovered slot re-learns the 429 at the cost of
 * one extra upstream round-trip, which is cheaper than persisting and
 * expiring per-model state in the database. There is no periodic sweep —
 * deadlines self-expire on read and entries are pruned on write. A windowless
 * streak survives expiry until this pair succeeds; the size cap bounds memory.
 */

/** Fallback TTL when a 429 carried no usable reset: long enough to stop
 * hammering a spent window, short enough to recover on its own. */
export const DEFAULT_MODEL_COOLDOWN_TTL_MS = 5 * 60 * 1000;

/** Upper bound on a caller-supplied reset (a weekly window plus slack), so a
 * malformed or hostile reset can't park a slot indefinitely. Mirrors
 * MAX_EXPLICIT_RESET_COOLDOWN_MS in rate-limit-cooldown.ts. */
export const MAX_MODEL_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;

/** Hard cap on distinct (account, model) entries, mirroring MAX_PROBE_GATES. */
const MAX_MODEL_COOLDOWN_ENTRIES = 10_000;

interface ModelCooldown {
	until: number;
	windowlessStreak?: number;
	windowless?: boolean;
}
const cooldowns = new Map<string, ModelCooldown>();
const log = new Logger("ModelCooldown");

/**
 * Normalizes the routing suffix off the model id (`stripModelRouting`) and
 * trims, so `deepseek {"only":["deepseek"]}` and `deepseek` share one entry —
 * the same slot reached through different combo specifications must not
 * maintain independent cooldowns.
 */
function normalizeModel(model: string): string {
	return stripModelRouting(model).trim();
}

function cooldownKey(accountId: string, model: string): string {
	return `${accountId}:${normalizeModel(model)}`;
}

function pruneExpired(now: number): void {
	for (const [key, entry] of cooldowns) {
		if (entry.until <= now && !entry.windowlessStreak) cooldowns.delete(key);
	}
}

/**
 * Records that (accountId, model) is cooling down until `untilMs`. A missing,
 * non-numeric or already-past `untilMs` falls back to
 * {@link DEFAULT_MODEL_COOLDOWN_TTL_MS} so a single 429 can't wedge the slot
 * indefinitely when no real reset was resolved; a future value is honoured but
 * capped at `now + MAX_MODEL_COOLDOWN_MS`. Expired entries are pruned while
 * writing, and the oldest-inserted entries are evicted once the map reaches
 * its size cap.
 */
export function markModelCooling(
	accountId: string,
	model: string,
	untilMs?: number | null,
	now: number = Date.now(),
): void {
	const until =
		typeof untilMs === "number" && untilMs > now
			? Math.min(untilMs, now + MAX_MODEL_COOLDOWN_MS)
			: now + DEFAULT_MODEL_COOLDOWN_TTL_MS;

	pruneExpired(now);
	while (cooldowns.size >= MAX_MODEL_COOLDOWN_ENTRIES) {
		const oldest = cooldowns.keys().next().value;
		if (oldest === undefined) break;
		cooldowns.delete(oldest);
	}
	const key = cooldownKey(accountId, model);
	cooldowns.set(key, {
		until,
		windowlessStreak: cooldowns.get(key)?.windowlessStreak,
	});
}

/** Windowless rejections keep their streak after expiry until this pair succeeds.
 * The existing bounded store owns both the deadline and backoff state. */
export function markWindowlessModelCooling(
	accountId: string,
	model: string,
	now: number = Date.now(),
): void {
	if (!model.trim()) return;
	const key = cooldownKey(accountId, model);
	const previous = cooldowns.get(key);
	const streak = (previous?.windowlessStreak ?? 0) + 1;
	const until = now + computeWindowless429CooldownMs(streak);
	const storedUntil = Math.max(until, previous?.until ?? 0);
	markModelCooling(accountId, model, until, now);
	cooldowns.set(key, {
		until: storedUntil,
		windowlessStreak: streak,
		windowless:
			previous?.until && previous.until > until ? previous.windowless : true,
	});
	if (!previous || previous.until <= now || !previous.windowlessStreak) {
		log.warn(
			`account=${accountId} model=${normalizeModel(model)} windowless_429 paused until ${new Date(storedUntil).toISOString()}`,
		);
	}
}

/** A success heals only this upstream pair, never another model on the account. */
export function recoverWindowlessModel(accountId: string, model: string): void {
	const key = cooldownKey(accountId, model);
	const entry = cooldowns.get(key);
	if (!entry?.windowlessStreak) return;
	if (entry.windowless) cooldowns.delete(key);
	else cooldowns.set(key, { until: entry.until });
	log.info(
		`account=${accountId} model=${normalizeModel(model)} recovered from windowless_429`,
	);
}

/**
 * The epoch-ms instant (accountId, model) stops cooling, or null when the pair
 * is not cooling. Callers that surface the deadline to an operator — the combo
 * skip log line and the combo detail API — need the timestamp itself, not just
 * the yes/no answer `isModelCooling` gives: "skipped" without "until when" is
 * what made a cooling slot look permanently dead. Expired deadlines stop
 * blocking immediately; windowless streaks remain until
 * success so the next rejection can back off even after natural expiry.
 */
export function getModelCooldownUntil(
	accountId: string,
	model: string,
	now: number = Date.now(),
): number | null {
	const key = cooldownKey(accountId, model);
	const entry = cooldowns.get(key);
	if (entry === undefined) return null;
	if (entry.until <= now) {
		if (!entry.windowlessStreak) cooldowns.delete(key);
		return null;
	}
	return entry.until;
}

/**
 * Every active per-model cooldown on an account, sorted by deadline (soonest
 * first). Combo passthrough slots have no model of their own, so
 * {@link getModelCooldownUntil}(accountId, "") can never match — this is how a
 * caller enumerates the pair cooldowns that can still block such a slot for the
 * model the client actually requested. Expired entries stop blocking, matching
 * {@link getModelCooldownUntil}.
 */
export function getModelCooldownsForAccount(
	accountId: string,
	now: number = Date.now(),
): Array<{ model: string; until: number }> {
	const prefix = `${accountId}:`;
	const active: Array<{ model: string; until: number }> = [];
	for (const [key, entry] of cooldowns) {
		if (!key.startsWith(prefix)) continue;
		if (entry.until <= now) {
			if (!entry.windowlessStreak) cooldowns.delete(key);
			continue;
		}
		active.push({ model: key.slice(prefix.length), until: entry.until });
	}
	return active.sort((a, b) => a.until - b.until);
}

/**
 * Whether (accountId, model) was recently marked cooling and hasn't expired.
 * Delegates to {@link getModelCooldownUntil} so the two can never disagree
 * about when an entry lapses.
 */
export function isModelCooling(
	accountId: string,
	model: string,
	now: number = Date.now(),
): boolean {
	return getModelCooldownUntil(accountId, model, now) !== null;
}

/**
 * Drops every cooldown entry for a removed account. Entries self-expire via
 * their `until`, but a removed account's keys otherwise sit until that fires —
 * this makes the clear proactive. Keyed as `accountId:model`, so removal is a
 * prefix scan rather than a single delete.
 */
export function clearModelCooldownsForAccount(accountId: string): void {
	const prefix = `${accountId}:`;
	for (const key of cooldowns.keys()) {
		if (key.startsWith(prefix)) cooldowns.delete(key);
	}
}

/** Test-only: reset all model-cooldown state between test cases. */
export function resetModelCooldownsForTests(): void {
	cooldowns.clear();
}
