/**
 * TokenHarbor peak-hours pricing, and the model-aware "is this account
 * peak-affected for this model?" decision built on it.
 *
 * TokenHarbor is an `anthropic-compatible` gateway that resells many upstream
 * models behind one key. Unlike Zai and DeepSeek — where peak hours are a
 * property of the *provider*, so the whole account pauses — only a handful of
 * its models carry a cheaper off-peak rate. Pausing the account at peak would
 * also block Claude, GLM, Grok and Gemini models that have no peak pricing at
 * all, so the toggle deliberately does NOT flip `accounts.paused`. It marks the
 * account as opted in, and the selector skips it for the specific models that
 * are actually peak-priced (see `isPeakAffected` below).
 *
 * The window and the model set both come from the account's own
 * `GET /v1/models` listing, which carries
 * `pricing.off_peak.window` (e.g. "14:00–00:00 UTC") on exactly the models
 * that have an off-peak rate. Nothing is hardcoded here: when TokenHarbor adds
 * or retires a peak-priced model, the next fetch picks it up.
 *
 * Failure is deliberately open. A listing that has never been fetched, or that
 * failed, leaves the account unconstrained — the worst case is paying peak
 * price, never a pool that silently stops routing to a healthy account.
 */
import {
	getEndpointUrl,
	mapModelName,
	stripModelRouting,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";

const log = new Logger("TokenHarborPeak");

/** The provider string a first-class TokenHarbor account stores. */
export const TOKENHARBOR_PROVIDER = "tokenharbor";

/**
 * Rows created before TokenHarbor had its own provider remain valid: they are
 * still accepted when their endpoint is TokenHarbor's, and the migration
 * rewrites them to {@link TOKENHARBOR_PROVIDER} on boot.
 */
export const LEGACY_TOKENHARBOR_PROVIDER = "anthropic-compatible";

/** Exact host, never suffix-based — see `isTokenHarborEndpoint`. */
const TOKENHARBOR_HOST = "tokenharbor.ai";

const FETCH_TIMEOUT_MS = 15_000;

/** How long a good listing is trusted before it is refetched. */
const LISTING_TTL_MS = 60 * 60 * 1000;

/** After a failed fetch, wait this long before trying again. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

const MINUTES_PER_DAY = 1440;

/**
 * True when the account's endpoint is TokenHarbor. Exact-host match on the
 * account's own endpoint, never on shared provider state — the
 * anthropic-compatible provider is a singleton serving every custom endpoint.
 */
export function isTokenHarborEndpoint(account?: Account | null): boolean {
	if (!account) return false;
	try {
		const url = new URL(getEndpointUrl(account));
		return url.hostname.toLowerCase() === TOKENHARBOR_HOST;
	} catch {
		return false;
	}
}

/**
 * Whether this row belongs to TokenHarbor. A first-class provider row always
 * does; a legacy anthropic-compatible row only when its endpoint is
 * TokenHarbor's, so other custom endpoints stay untouched.
 */
export function isTokenHarborAccount(account?: Account | null): boolean {
	if (!account) return false;
	return (
		account.provider === TOKENHARBOR_PROVIDER ||
		(account.provider === LEGACY_TOKENHARBOR_PROVIDER &&
			isTokenHarborEndpoint(account))
	);
}

/**
 * Parse an off-peak window spec into UTC minute-of-day bounds.
 *
 * Accepts the shape the listing actually uses — "14:00–00:00 UTC", with an
 * en dash, a hyphen or a tilde as the separator — and returns null for
 * anything else. A window ending at 00:00 means end-of-day (1440), not
 * midnight-of-the-same-day, so the common "evening to midnight" case is a
 * plain range rather than a wrapping one.
 *
 * Only UTC is accepted. A listing that switched to a named zone would fail
 * here and degrade to "no constraint", which is the safe direction.
 */
export function parseOffPeakWindow(
	spec: string | null | undefined,
): { startMin: number; endMin: number } | null {
	if (typeof spec !== "string") return null;
	const match = /^(\d{1,2}):(\d{2})\s*[-–—~]\s*(\d{1,2}):(\d{2})\s*UTC$/i.exec(
		spec.trim(),
	);
	if (!match) return null;

	const startMin = Number(match[1]) * 60 + Number(match[2]);
	const endHour = Number(match[3]);
	const endMinute = Number(match[4]);
	if (Number(match[2]) > 59 || endMinute > 59) return null;
	if (Number(match[1]) > 24 || endHour > 24) return null;

	// 24:00 only makes sense as an end bound.
	if (Number(match[1]) === 24) return null;
	// "00:00" as an END means end-of-day (1440), not midnight at the start of
	// the same day: "14:00–00:00" is an evening-to-midnight range, not a
	// wrapping one.
	const endMin =
		endHour === 24 || (endHour === 0 && endMinute === 0)
			? MINUTES_PER_DAY
			: endHour * 60 + endMinute;
	if (endMin > MINUTES_PER_DAY) return null;
	if (startMin === endMin) return null;

	return { startMin, endMin };
}

/**
 * True when `ts` falls inside [startMin, endMin) UTC, every day of the week.
 * Wrapping windows (start > end) are supported.
 *
 * TokenHarbor confirmed the off-peak rate runs every day including weekdays
 * and weekends, so there is deliberately no weekday or holiday gate here —
 * unlike DeepSeek, whose upstream calendar does have one.
 */
export function isInOffPeakWindow(
	window: { startMin: number; endMin: number },
	ts: number,
): boolean {
	if (!Number.isFinite(ts)) return false;
	const d = new Date(ts);
	const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
	if (window.startMin < window.endMin) {
		return minute >= window.startMin && minute < window.endMin;
	}
	return minute >= window.startMin || minute < window.endMin;
}

/** One model that carries an off-peak rate, and the window that applies to it. */
export interface PeakPricedModel {
	id: string;
	window: { startMin: number; endMin: number };
}

/** What one TokenHarbor account's listing says about peak pricing. */
export interface TokenHarborPeakListing {
	accountId: string;
	/** Model id -> its off-peak window. Empty means nothing is peak-priced. */
	models: Map<string, { startMin: number; endMin: number }>;
	fetchedAt: number;
	/**
	 * The account row the listing was fetched for. Kept so callers that hold
	 * only an account id — the request summary and `/api/requests` — can still
	 * resolve a client model onto the upstream model the listing keys on.
	 */
	account: Account;
}

interface TokenHarborModelsResponse {
	data?: Array<{
		id?: unknown;
		pricing?: { off_peak?: { window?: unknown } | null } | null;
	}>;
}

/**
 * Pull the peak-priced models out of a `/v1/models` body. A model with no
 * `off_peak` block, or one whose window cannot be parsed, is simply not
 * peak-priced — it never constrains routing.
 */
export function extractPeakPricedModels(
	body: TokenHarborModelsResponse,
): Map<string, { startMin: number; endMin: number }> {
	const models = new Map<string, { startMin: number; endMin: number }>();
	for (const raw of body?.data ?? []) {
		const id = typeof raw?.id === "string" ? raw.id.trim() : "";
		if (!id) continue;
		const window = parseOffPeakWindow(raw?.pricing?.off_peak?.window as string);
		if (window) models.set(id, window);
	}
	return models;
}

// ── Listing cache ──────────────────────────────────────────────────────────
//
// Process-local, one entry per account, keyed by account id. A listing is
// TokenHarbor's own catalog, so unlike openai-compatible accounts it is the
// same for every account on the host — but it is still fetched per account
// because the fetch needs that account's key.

const listings = new Map<string, TokenHarborPeakListing>();
const inflight = new Map<string, Promise<TokenHarborPeakListing | null>>();
const lastFailureAt = new Map<string, number>();

/** Test seam: the cache is process-wide and would leak between cases. */
export function clearTokenHarborPeakCacheForTests(): void {
	listings.clear();
	inflight.clear();
	lastFailureAt.clear();
}

/** Drops a removed account's listing so it does not linger. */
export function clearTokenHarborPeakCacheForAccount(accountId: string): void {
	listings.delete(accountId);
	inflight.delete(accountId);
	lastFailureAt.delete(accountId);
}

async function fetchListing(
	account: Account,
): Promise<TokenHarborPeakListing | null> {
	const apiKey = account.api_key;
	if (!apiKey) {
		log.warn(
			`No API key on TokenHarbor account ${account.name}; peak pricing unknown`,
		);
		return null;
	}
	// A first-class TokenHarbor row may carry no custom_endpoint at all; the
	// shared getEndpointUrl default is OpenAI's, so fall back explicitly.
	const endpoint = account.custom_endpoint?.trim() || "https://tokenharbor.ai";
	const base = endpoint.replace(/\/+$/, "");
	const url = `${base}${base.endsWith("/v1") ? "" : "/v1"}/models`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${apiKey}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const listing: TokenHarborPeakListing = {
			accountId: account.id,
			models: extractPeakPricedModels(
				(await response.json()) as TokenHarborModelsResponse,
			),
			fetchedAt: Date.now(),
			account,
		};
		listings.set(account.id, listing);
		lastFailureAt.delete(account.id);
		return listing;
	} catch (error) {
		lastFailureAt.set(account.id, Date.now());
		const cached = listings.get(account.id);
		log.warn(
			`TokenHarbor model listing failed for ${account.name} (${error}); ` +
				(cached
					? `keeping the listing from ${new Date(cached.fetchedAt).toISOString()}`
					: "peak pricing unknown, routing unconstrained"),
		);
		return cached ?? null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * The account's cached listing, refetched when stale. Concurrent callers share
 * one in-flight request. Returns null when nothing has ever been fetched.
 */
export async function getTokenHarborPeakListing(
	account: Account,
): Promise<TokenHarborPeakListing | null> {
	const cached = listings.get(account.id);
	if (cached && Date.now() - cached.fetchedAt < LISTING_TTL_MS) return cached;

	const failedAt = lastFailureAt.get(account.id);
	if (failedAt !== undefined && Date.now() - failedAt < FAILURE_BACKOFF_MS) {
		return cached ?? null;
	}

	const pending = inflight.get(account.id);
	if (pending) return pending;

	const promise = fetchListing(account).finally(() => {
		inflight.delete(account.id);
	});
	inflight.set(account.id, promise);
	return promise;
}

/**
 * The listing without ever waiting on the network: the cached copy, or null.
 * This is what the request path uses — a routing decision must not block on a
 * 15-second HTTP call.
 */
export function peekTokenHarborPeakListing(
	accountId: string,
): TokenHarborPeakListing | null {
	return listings.get(accountId) ?? null;
}

/**
 * Whether this account should be skipped for `requestModel` right now because
 * the model it would actually call is peak-priced and we are inside that
 * model's peak window.
 *
 * The model that matters is the one the account would be asked for, not the
 * one the client named: an account remapping `claude-opus-5-5` onto
 * `deepseek-v4-pro` is peak-affected for that request even though the request
 * says "claude". `mapModelName` resolves the same way the outbound request
 * does.
 *
 * Returns false — route normally — for every case we cannot answer: the
 * toggle is off, no listing has been fetched yet, the model is not in the
 * peak-priced set, or the model is unknown (no model means no per-model
 * decision to make).
 */
export function isPeakAffected(
	account: Account,
	requestModel: string | null | undefined,
	ts = Date.now(),
): boolean {
	if (!account.peak_hours_pause_enabled) return false;
	if (!requestModel || requestModel.trim() === "") return false;

	const listing = listings.get(account.id);
	if (!listing) return false;
	// The listing is keyed by account id, so an endpoint or provider edit keeps
	// it alive for a row that is no longer the upstream it was fetched from.
	// Prices from that upstream must not govern the new one: fail open instead
	// of skipping another gateway on TokenHarbor's prices. A plain string
	// comparison on the stored row, not a URL parse — this is the request path.
	if (
		(account.provider !== TOKENHARBOR_PROVIDER &&
			account.provider !== LEGACY_TOKENHARBOR_PROVIDER) ||
		account.custom_endpoint !== listing.account.custom_endpoint
	) {
		return false;
	}

	// `mapModelName` keeps a provider-routing suffix (`model {"only":[...]}`)
	// on the value it returns, because the request rewriter reads it back out.
	// That suffix is not part of any listing id, so strip it before matching.
	const mapped = stripModelRouting(mapModelName(requestModel, account));
	const window = listing.models.get(mapped);
	if (!window) return false;

	return !isInOffPeakWindow(window, ts);
}

/** Number of accounts with a cached listing; for the scheduler's logging. */
export function tokenHarborPeakCacheSize(): number {
	return listings.size;
}

/** The peak-priced model ids known for an account, for UI copy. */
export function getPeakPricedModelIds(accountId: string): string[] | null {
	const listing = listings.get(accountId);
	return listing ? [...listing.models.keys()].sort() : null;
}

/**
 * Server-computed peak state for an account, in the same `{ active }` shape
 * `getPeakHoursState` serves for the provider-wide windows, so the dashboard
 * needs no second code path.
 *
 * `active` means "at least one peak-priced model this account can call is
 * inside its peak window right now" — i.e. the account is being skipped for
 * that model. With `model` given the question is narrowed to that one model,
 * which is what a request summary wants.
 *
 * Returns null when the account has no cached listing (never fetched, fetch
 * failed, or the toggle was never on) — "no opinion", not "off peak".
 */
export function getTokenHarborPeakState(
	accountId: string,
	model: string | null | undefined,
	ts = Date.now(),
): { active: boolean } | null {
	const listing = listings.get(accountId);
	if (!listing) return null;

	if (model) {
		// The caller may hand us either the model the client named (resolved
		// through the account's mappings) or the upstream id already. Try the
		// mapping first, then the literal string.
		const mapped = stripModelRouting(mapModelName(model, listing.account));
		const window =
			listing.models.get(mapped) ??
			listing.models.get(stripModelRouting(model));
		if (!window) return null;
		return { active: !isInOffPeakWindow(window, ts) };
	}

	for (const window of listing.models.values()) {
		if (!isInOffPeakWindow(window, ts)) return { active: true };
	}
	return { active: false };
}
