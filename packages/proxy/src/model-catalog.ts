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
	if (raw === undefined) return 24;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 24;
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
	return { models, fetchedAt: Date.now(), source: "fallback" };
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
 * Select the best-suited active Anthropic account to use for the live
 * `/v1/models` fetch: not paused, provider is an Anthropic-family provider,
 * no `custom_endpoint` override (a provider="anthropic" account pointed at a
 * third-party/compatible endpoint would otherwise have its foreign model list
 * persisted as the "live" Anthropic catalog), lowest `priority` number wins
 * (mirrors account-selector conventions).
 */
function selectEligibleAccount(accounts: Account[]): Account | null {
	const eligible = accounts.filter(
		(a) =>
			ANTHROPIC_ACCOUNT_PROVIDERS.has(a.provider) &&
			!a.paused &&
			!a.custom_endpoint,
	);
	if (eligible.length === 0) return null;
	return eligible.reduce((best, current) =>
		current.priority < best.priority ? current : best,
	);
}

/**
 * Fetch the live list of models from Anthropic's `/v1/models` endpoint using
 * an active account's credentials. Paginates via `after_id` up to
 * `MAX_PAGES` pages defensively.
 */
export async function fetchLiveModels(
	ctx: ProxyContext,
): Promise<ModelCatalogEntry[]> {
	const accounts = await ctx.dbOps.getAllAccounts();
	const account = selectEligibleAccount(accounts);
	if (!account) {
		throw new Error("No active anthropic account available to fetch models");
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
 * Trigger a refresh of the live model catalog. Fail-open: on any error
 * (offline switch, no eligible account, fetch failure), the previous cache
 * (in-memory, falling back to disk, falling back to the bundled static
 * list) is preserved and returned; the error is reported but never thrown.
 */
export async function refreshModelCatalog(
	ctx: ProxyContext,
): Promise<ModelCatalogRefreshResult> {
	if (isOffline()) {
		const catalog = await getModelCatalog();
		return {
			success: false,
			error:
				"Model catalog refresh is disabled (BETTER_CCFLARE_MODELS_OFFLINE=1)",
			catalog,
		};
	}

	try {
		const models = await fetchLiveModels(ctx);
		const catalog: ModelCatalog = {
			models,
			fetchedAt: Date.now(),
			source: "live",
		};
		memoryCatalog = catalog;
		diskLoadAttempted = true;
		await saveToDisk(catalog);
		return { success: true, catalog };
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

const MODEL_CATALOG_REFRESH_INTERVAL_ID = "model-catalog-refresh";

/**
 * Register the periodic model catalog refresh. Runs an immediate refresh on
 * registration unless a live cache already on disk/in memory is still within
 * the TTL (avoids a live upstream call on every dev-server restart), then
 * schedules the periodic refresh every `BETTER_CCFLARE_MODELS_REFRESH_HOURS`
 * hours (default 24; set to 0 to disable periodic refresh entirely — the
 * initial immediate refresh is skipped too).
 * Returns an unregister function.
 */
export function initModelCatalogRefresh(ctx: ProxyContext): () => void {
	const hours = getRefreshHours();
	if (hours <= 0) {
		log.info("Model catalog periodic refresh disabled (refresh hours = 0)");
		return () => {};
	}

	// Run an initial refresh immediately (non-blocking for the caller) unless
	// the existing cache is a live one still within the TTL window, then
	// schedule the periodic refresh. registerHeartbeat itself does not run
	// its callback immediately on registration.
	void (async () => {
		const existing = await getModelCatalog();
		const ttlMs = hours * 60 * 60 * 1000;
		const isFresh =
			existing.source === "live" && Date.now() - existing.fetchedAt < ttlMs;
		if (isFresh) {
			log.debug(
				"Skipping immediate model catalog refresh: cache is still fresh",
				{
					ageMs: Date.now() - existing.fetchedAt,
					ttlMs,
				},
			);
			return;
		}
		await refreshModelCatalog(ctx);
	})();

	return registerHeartbeat({
		id: MODEL_CATALOG_REFRESH_INTERVAL_ID,
		callback: async () => {
			await refreshModelCatalog(ctx);
		},
		seconds: hours * 60 * 60,
		description: `Model catalog refresh every ${hours}h`,
	});
}

/**
 * Reset internal in-memory state. Intended for test cleanup only.
 */
export function resetModelCatalogForTest(): void {
	memoryCatalog = null;
	diskLoadAttempted = false;
}
