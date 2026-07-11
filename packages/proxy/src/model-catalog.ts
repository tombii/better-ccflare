/**
 * Live Anthropic model catalog.
 *
 * Periodically fetches the list of available models from the Anthropic
 * `/v1/models` API (using an existing, active Anthropic account's
 * credentials) and caches the result both in memory and on disk. Falls back
 * to the last known-good cache — and ultimately to the bundled
 * `CLAUDE_MODEL_IDS` list — if a live fetch is unavailable.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUNDLED_MODELS_AS_OF,
	CLAUDE_MODEL_IDS,
	getModelDisplayName,
	registerHeartbeat,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { getProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers/proxy-types";
import { getValidAccessToken } from "./handlers/token-manager";

const log = new Logger("ModelCatalog");

export interface ModelCatalogEntry {
	id: string;
	displayName: string;
	createdAt: string | null;
}

export interface ModelCatalog {
	models: ModelCatalogEntry[];
	fetchedAt: number;
	source: "live" | "fallback";
	/**
	 * Epoch ms after which the next scheduled refresh is due. Recomputed and
	 * persisted on every successful catalog write (scheduled, manual, or
	 * passive capture) via `computeNextRefreshAt`. Optional for backward
	 * compatibility with v1 on-disk caches written before this field existed.
	 */
	nextRefreshAt?: number;
}

export interface ModelCatalogRefreshResult {
	success: boolean;
	error?: string;
	catalog: ModelCatalog;
}

interface AnthropicModelsPageResponse {
	data: Array<{
		id: string;
		display_name?: string;
		created_at?: string;
	}>;
	has_more?: boolean;
	first_id?: string | null;
	last_id?: string | null;
}

const MAX_PAGES = 5;
const FETCH_TIMEOUT_MS = 10_000;

// Anthropic OAuth/console accounts are both served by the "anthropic"
// provider adapter (AnthropicProvider handles token refresh + header prep
// for both auth modes).
const ANTHROPIC_ACCOUNT_PROVIDERS = new Set([
	"anthropic",
	"claude-console-api",
]);

// API-key ("console") accounts are the sanctioned surface for recurring,
// non-interactive traffic. OAuth accounts are only added to the eligible
// pool when explicitly opted in (manual refresh, or the OAuth-auto-refresh
// config flag) — see `selectEligibleAccount`.
const CONSOLE_ONLY_PROVIDERS = new Set(["claude-console-api"]);

/** Upper bound on the random jitter added on top of the refresh interval. */
const MAX_JITTER_MS = 24 * 60 * 60 * 1000;
/** Cap on the backoff delay used to retry after a failed automatic refresh. */
const RETRY_INTERVAL_CAP_MS = 6 * 60 * 60 * 1000;
/** Random initial-tick delay range, smearing refreshes across a restart storm. */
const MIN_INITIAL_DELAY_MS = 30_000;
const MAX_INITIAL_DELAY_MS = 120_000;
/** How often the scheduler wakes up to check whether a refresh is due. */
const DEFAULT_TICK_SECONDS = 15 * 60;

function getCacheDir(): string {
	return (
		process.env.BETTER_CCFLARE_MODELS_CACHE_DIR ||
		join(tmpdir(), "better-ccflare")
	);
}

function getCachePath(): string {
	return join(getCacheDir(), "anthropic-models.json");
}

function getRefreshHours(): number {
	const raw = process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS;
	if (raw === undefined) return 168;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 168;
}

function isOffline(): boolean {
	return process.env.BETTER_CCFLARE_MODELS_OFFLINE === "1";
}

function fallbackCatalog(): ModelCatalog {
	const models: ModelCatalogEntry[] = Object.values(CLAUDE_MODEL_IDS).map(
		(id) => ({
			id,
			displayName: getModelDisplayName(id),
			createdAt: null,
		}),
	);
	// Use the bundled list's snapshot date rather than "now" — this catalog
	// wasn't just fetched, and reporting Date.now() would misleadingly imply
	// freshness to a fresh install with no live-refreshable account.
	return {
		models,
		fetchedAt: Date.parse(BUNDLED_MODELS_AS_OF),
		source: "fallback",
	};
}

/** In-memory cache, populated from disk on first access. */
let memoryCatalog: ModelCatalog | null = null;
let diskLoadAttempted = false;

async function ensureCacheDir(): Promise<void> {
	try {
		await fs.mkdir(getCacheDir(), { recursive: true });
	} catch (error) {
		log.warn("Failed to create model catalog cache directory: %s", error);
	}
}

async function loadFromDisk(): Promise<ModelCatalog | null> {
	try {
		const content = await fs.readFile(getCachePath(), "utf-8");
		const parsed = JSON.parse(content) as ModelCatalog;
		if (!Array.isArray(parsed.models) || typeof parsed.fetchedAt !== "number") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

async function saveToDisk(catalog: ModelCatalog): Promise<void> {
	try {
		await ensureCacheDir();
		await fs.writeFile(getCachePath(), JSON.stringify(catalog, null, 2));
	} catch (error) {
		log.warn("Failed to save model catalog cache: %s", error);
	}
}

/**
 * Compute the epoch ms at which the next scheduled refresh becomes due:
 * `fetchedAt + intervalMs + random(0..min(MAX_JITTER_MS, intervalMs))`. The
 * jitter smears refresh timing across independently-restarting instances so
 * they don't all hit Anthropic at the same wall-clock moment.
 */
function computeNextRefreshAt(fetchedAt: number, intervalMs: number): number {
	const jitterMs = Math.random() * Math.min(MAX_JITTER_MS, intervalMs);
	return fetchedAt + intervalMs + jitterMs;
}

/**
 * Select the best-suited active Anthropic account to use for the live
 * `/v1/models` fetch: not paused, no `custom_endpoint` override (a
 * provider="anthropic" account pointed at a third-party/compatible endpoint
 * would otherwise have its foreign model list persisted as the "live"
 * Anthropic catalog). By default only `claude-console-api` (API-key) accounts
 * are eligible — recurring background traffic against a consumer OAuth
 * account risks an account flag/ban, so OAuth accounts only join the pool
 * when `allowOAuth` is set (manual refresh, or the OAuth-auto-refresh opt-in
 * for scheduled refreshes). Console accounts always win over OAuth accounts;
 * ties break on the lowest `priority` number (mirrors account-selector
 * conventions).
 */
function selectEligibleAccount(
	accounts: Account[],
	{ allowOAuth }: { allowOAuth: boolean },
): Account | null {
	const providers = allowOAuth
		? ANTHROPIC_ACCOUNT_PROVIDERS
		: CONSOLE_ONLY_PROVIDERS;
	const eligible = accounts.filter(
		(a) => providers.has(a.provider) && !a.paused && !a.custom_endpoint,
	);
	if (eligible.length === 0) return null;
	// Console accounts win over OAuth accounts regardless of priority (the
	// ban-risk-motivated preference), then lowest `priority` number wins.
	return eligible.reduce((best, current) => {
		const bestIsConsole = best.provider === "claude-console-api";
		const currentIsConsole = current.provider === "claude-console-api";
		if (currentIsConsole !== bestIsConsole) {
			return currentIsConsole ? current : best;
		}
		return current.priority < best.priority ? current : best;
	});
}

/**
 * Fetch the live list of models from Anthropic's `/v1/models` endpoint using
 * an active account's credentials. Paginates via `after_id` up to
 * `MAX_PAGES` pages defensively.
 */
export async function fetchLiveModels(
	ctx: ProxyContext,
	options?: { allowOAuth?: boolean },
): Promise<ModelCatalogEntry[]> {
	const allowOAuth = options?.allowOAuth ?? false;
	const accounts = await ctx.dbOps.getAllAccounts();
	const account = selectEligibleAccount(accounts, { allowOAuth });
	if (!account) {
		throw new Error(
			allowOAuth
				? "No active anthropic account available to fetch models"
				: "No active anthropic account available to fetch models (console/API-key accounts only; set BETTER_CCFLARE_MODELS_OAUTH_REFRESH=1 or use a manual refresh to allow an OAuth account fallback)",
		);
	}

	const provider = getProvider(account.provider) || ctx.provider;
	const accessToken = await getValidAccessToken(account, ctx);
	const headers = provider.prepareHeaders(
		new Headers(),
		accessToken,
		account.api_key || undefined,
	);
	headers.set("anthropic-version", "2023-06-01");

	const models: ModelCatalogEntry[] = [];
	let afterId: string | null = null;
	let page = 0;

	while (page < MAX_PAGES) {
		page++;
		const query = afterId ? `?after_id=${encodeURIComponent(afterId)}` : "";
		const url = provider.buildUrl("/v1/models", query, account);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetch(url, {
				method: "GET",
				headers,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeoutId);
		}

		if (!response.ok) {
			throw new Error(
				`Failed to fetch live models: HTTP ${response.status} ${response.statusText}`,
			);
		}

		const body = (await response.json()) as AnthropicModelsPageResponse;
		for (const m of body.data ?? []) {
			models.push({
				id: m.id,
				displayName: m.display_name || m.id,
				createdAt: m.created_at ?? null,
			});
		}

		if (!body.has_more || !body.last_id) break;
		afterId = body.last_id;
	}

	return models;
}

/**
 * Get the current model catalog. Loads from disk on first call if no
 * in-memory cache exists yet; falls back to the bundled static model list
 * when neither an in-memory nor an on-disk cache is available.
 */
export async function getModelCatalog(): Promise<ModelCatalog> {
	if (memoryCatalog) return memoryCatalog;

	if (!diskLoadAttempted) {
		diskLoadAttempted = true;
		const fromDisk = await loadFromDisk();
		if (fromDisk) {
			memoryCatalog = fromDisk;
			return memoryCatalog;
		}
	}

	return fallbackCatalog();
}

/**
 * Whether the automatic (scheduled) refresh is allowed to fall back to an
 * OAuth account when no eligible console (API-key) account exists. Reads
 * `Config.getModelCatalogOAuthRefreshEnabled()` (env var > config file >
 * default `false`). A manual, human-triggered refresh always allows the
 * OAuth fallback regardless of this flag.
 */
function isOAuthAutoRefreshEnabled(ctx: ProxyContext): boolean {
	return ctx.config.getModelCatalogOAuthRefreshEnabled();
}

/**
 * Persist a freshly-fetched catalog as the new in-memory + on-disk cache,
 * recomputing `nextRefreshAt` from the current refresh interval. Every
 * successful catalog write — scheduled, manual, or passive capture — funnels
 * through this so `nextRefreshAt` always reflects the most recent write.
 */
async function finalizeCatalogWrite(
	catalog: ModelCatalog,
): Promise<ModelCatalog> {
	const intervalMs = getRefreshHours() * 60 * 60 * 1000;
	const finalized: ModelCatalog = {
		...catalog,
		nextRefreshAt: computeNextRefreshAt(catalog.fetchedAt, intervalMs),
	};
	memoryCatalog = finalized;
	diskLoadAttempted = true;
	await saveToDisk(finalized);
	return finalized;
}

/**
 * Trigger a refresh of the live model catalog. Fail-open: on any error
 * (offline switch, no eligible account, fetch failure), the previous cache
 * (in-memory, falling back to disk, falling back to the bundled static
 * list) is preserved and returned; the error is reported but never thrown.
 *
 * `trigger` controls OAuth-account eligibility: `"automatic"` (the default,
 * used by the scheduler) only allows an OAuth account fallback when the
 * `getModelCatalogOAuthRefreshEnabled()` opt-in is set; `"manual"` (a
 * human-triggered refresh from the CLI/dashboard) always allows it, with
 * console accounts still preferred.
 */
export async function refreshModelCatalog(
	ctx: ProxyContext,
	options?: { trigger?: "manual" | "automatic" },
): Promise<ModelCatalogRefreshResult> {
	const trigger = options?.trigger ?? "automatic";
	if (isOffline()) {
		const catalog = await getModelCatalog();
		return {
			success: false,
			error:
				"Model catalog refresh is disabled (BETTER_CCFLARE_MODELS_OFFLINE=1)",
			catalog,
		};
	}

	const allowOAuth =
		trigger === "manual" ? true : isOAuthAutoRefreshEnabled(ctx);

	try {
		const models = await fetchLiveModels(ctx, { allowOAuth });
		const catalog: ModelCatalog = {
			models,
			fetchedAt: Date.now(),
			source: "live",
		};
		const finalized = await finalizeCatalogWrite(catalog);
		return { success: true, catalog: finalized };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn(
			"Model catalog refresh failed, keeping previous cache: %s",
			message,
		);
		const catalog = await getModelCatalog();
		return { success: false, error: message, catalog };
	}
}

/**
 * Passively capture a `GET /v1/models` response that was already forwarded
 * to a client for some other reason (e.g. a user's own `curl` against the
 * proxy), and fold it into the catalog. This never triggers a new upstream
 * call — it only *observes* traffic that would have happened anyway — so
 * unlike `refreshModelCatalog` it carries no ban-risk trade-off and is not
 * gated by account-eligibility/OAuth-opt-in policy. Never throws: any
 * failure (offline, wrong provider, malformed body, empty listing) is
 * logged at debug level and treated as a no-op, leaving the existing
 * catalog untouched.
 *
 * Gates, in order:
 *  - `isOffline()` — the offline switch also disables passive capture.
 *  - `account` must be a non-custom-endpoint `anthropic`/`claude-console-api`
 *    account — a third-party-compatible endpoint responding to a client's
 *    own `GET /v1/models` must never poison the catalog with foreign models.
 *  - An empty `data` array is a no-op — the catalog is never emptied by a
 *    passive observation.
 *
 * Merge semantics, based on whether the *observed response* represents a
 * complete listing (`has_more !== true` and the request wasn't itself a
 * paginated `after_id` follow-up):
 *  - Complete → **replace** the catalog outright (so retired models drop
 *    out, matching a real scheduled/manual refresh).
 *  - Partial, observed while the current catalog is already `"live"` →
 *    **merge by id** (upsert only, no deletions — a single page must never
 *    be mistaken for the full set).
 *  - Partial, observed while the current catalog is still the bundled
 *    `"fallback"` → **skip** — stitching one live page onto the static
 *    fallback would produce a catalog that's neither, and incorrectly
 *    labeled `"live"`.
 */
export async function ingestModelsListing(
	bodyText: string,
	account: Account | null | undefined,
	requestQuery?: string | null,
): Promise<void> {
	try {
		if (isOffline()) return;
		if (
			!account ||
			!ANTHROPIC_ACCOUNT_PROVIDERS.has(account.provider) ||
			account.custom_endpoint
		) {
			return;
		}

		const body = JSON.parse(bodyText) as AnthropicModelsPageResponse;
		if (!Array.isArray(body.data) || body.data.length === 0) return;

		const observed: ModelCatalogEntry[] = body.data.map((m) => ({
			id: m.id,
			displayName: m.display_name || m.id,
			createdAt: m.created_at ?? null,
		}));

		const params = new URLSearchParams(requestQuery ?? "");
		const isComplete = body.has_more !== true && !params.has("after_id");

		const existing = await getModelCatalog();
		let models: ModelCatalogEntry[];
		if (isComplete) {
			models = observed;
		} else if (existing.source === "live") {
			const byId = new Map(existing.models.map((m) => [m.id, m]));
			for (const entry of observed) byId.set(entry.id, entry);
			models = Array.from(byId.values());
		} else {
			return;
		}

		await finalizeCatalogWrite({
			models,
			fetchedAt: Date.now(),
			source: "live",
		});
	} catch (error) {
		log.debug("Passive model catalog capture skipped: %s", error);
	}
}

const MODEL_CATALOG_REFRESH_INTERVAL_ID = "model-catalog-refresh";

/**
 * Derive the epoch ms at which the scheduler's next refresh attempt is due,
 * on (re)start: adopt the persisted `nextRefreshAt` if present and still
 * within the current interval's bounds; otherwise derive one from the
 * cached `fetchedAt` + interval + jitter (clamping a stale, longer-interval
 * `nextRefreshAt` down if `BETTER_CCFLARE_MODELS_REFRESH_HOURS` was lowered
 * since it was computed); `null` means "due immediately".
 */
async function deriveInitialNextRefreshAt(
	intervalMs: number,
): Promise<number | null> {
	const existing = await getModelCatalog();
	if (typeof existing.nextRefreshAt === "number") {
		const maxAllowed =
			existing.fetchedAt + intervalMs + Math.min(MAX_JITTER_MS, intervalMs);
		if (existing.nextRefreshAt <= maxAllowed) {
			return existing.nextRefreshAt;
		}
		return computeNextRefreshAt(existing.fetchedAt, intervalMs);
	}
	if (typeof existing.fetchedAt === "number") {
		return computeNextRefreshAt(existing.fetchedAt, intervalMs);
	}
	return null;
}

/**
 * Register the "tick-and-check" model catalog refresh scheduler:
 *  1. Loads the persisted `nextRefreshAt` (or derives one from the cached
 *     `fetchedAt` + interval + jitter, clamping if the configured interval
 *     was lowered since), so the schedule survives restarts.
 *  2. Fires an initial tick after a random 30-120s delay (smears refresh
 *     load across a fleet restarting together), then ticks every 15
 *     minutes thereafter, each time just checking whether `nextRefreshAt`
 *     has passed — a lightweight heartbeat rather than a per-cadence timer.
 *  3. Every tick uses `trigger: "automatic"` (console-only unless the
 *     OAuth-auto-refresh opt-in is set — see `isOAuthAutoRefreshEnabled`).
 *  4. On a failed refresh, retries sooner (`min(interval, 6h)`) rather than
 *     waiting out the full interval, so e.g. a newly-added console account
 *     is picked up promptly.
 * Set `BETTER_CCFLARE_MODELS_REFRESH_HOURS=0` to disable entirely.
 * `testOverrides` lets tests replace the random initial delay and the
 * 15-minute heartbeat cadence with near-instant values. Returns an
 * unregister function.
 */
export interface ModelCatalogTestOverrides {
	/** Override the random 30-120s initial-tick delay, for tests. */
	initialDelayMs?: number;
	/** Override the 15-minute heartbeat tick interval (in seconds), for tests. */
	tickSeconds?: number;
}

export function initModelCatalogRefresh(
	ctx: ProxyContext,
	testOverrides?: ModelCatalogTestOverrides,
): () => void {
	const hours = getRefreshHours();
	if (hours <= 0) {
		log.info("Model catalog periodic refresh disabled (refresh hours = 0)");
		return () => {};
	}
	const intervalMs = hours * 60 * 60 * 1000;

	let nextRefreshAt: number | null = null;
	let isRefreshing = false;
	let initialTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let unregistered = false;

	const tick = async () => {
		if (isRefreshing || unregistered) return;
		if (nextRefreshAt !== null && nextRefreshAt > Date.now()) return;

		isRefreshing = true;
		try {
			const result = await refreshModelCatalog(ctx, { trigger: "automatic" });
			nextRefreshAt = result.success
				? (result.catalog.nextRefreshAt ?? null)
				: Date.now() + Math.min(intervalMs, RETRY_INTERVAL_CAP_MS);
		} finally {
			isRefreshing = false;
		}
	};

	// Determine the initial due time from the persisted cache (so the
	// schedule survives restarts), then fire the first tick after a random
	// delay to smear refresh load across a fleet restarting together.
	void (async () => {
		const derived = await deriveInitialNextRefreshAt(intervalMs);
		if (unregistered) return;
		nextRefreshAt = derived;

		const initialDelayMs =
			testOverrides?.initialDelayMs ??
			MIN_INITIAL_DELAY_MS +
				Math.random() * (MAX_INITIAL_DELAY_MS - MIN_INITIAL_DELAY_MS);
		initialTimeoutId = setTimeout(() => {
			void tick();
		}, initialDelayMs);
	})();

	const tickSeconds = testOverrides?.tickSeconds ?? DEFAULT_TICK_SECONDS;
	const unregisterHeartbeat = registerHeartbeat({
		id: MODEL_CATALOG_REFRESH_INTERVAL_ID,
		callback: tick,
		seconds: tickSeconds,
		description: `Model catalog refresh check every ${tickSeconds}s (cadence ~${hours}h + jitter)`,
	});

	return () => {
		unregistered = true;
		if (initialTimeoutId !== null) clearTimeout(initialTimeoutId);
		unregisterHeartbeat();
	};
}

/**
 * Reset internal in-memory state. Intended for test cleanup only.
 */
export function resetModelCatalogForTest(): void {
	memoryCatalog = null;
	diskLoadAttempted = false;
}
