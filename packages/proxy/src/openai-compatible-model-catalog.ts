import { getEndpointUrl, validateEndpointUrl } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	hasDerivedProviderModelDefaults,
	setDerivedProviderModelDefaults,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers/proxy-types";

const log = new Logger("OpenAICompatibleModelCatalog");

/**
 * Models one `openai-compatible` account can actually call, read straight from
 * that account's own endpoint via the standard OpenAI `GET /v1/models` shape.
 *
 * Unlike Codex, every account here points at an operator-chosen, arbitrary
 * endpoint — there is no single upstream all accounts share — so, unlike
 * `codex-model-catalog.ts`, listings are never borrowed between accounts.
 * Each account's cache answers only for itself.
 */
export interface OpenAICompatibleModelEntry {
	id: string;
	displayName: string;
}

export interface OpenAICompatibleModelListing {
	accountId: string;
	models: OpenAICompatibleModelEntry[];
	fetchedAt: number;
	source: "live" | "cached";
}

const FETCH_TIMEOUT_MS = 15_000;

/** Last good listing per account, for this process only — see codex-model-catalog.ts for the rationale. */
const lastGood = new Map<string, OpenAICompatibleModelListing>();

/** Test seam: process-wide registry leaks between cases. */
export function clearOpenAICompatibleModelCacheForTests(): void {
	lastGood.clear();
}

/** Drops a removed account's listing so it doesn't linger in `lastGood` forever. */
export function clearOpenAICompatibleModelCacheForAccount(
	accountId: string,
): void {
	lastGood.delete(accountId);
}

function readCache(accountId: string): OpenAICompatibleModelListing | null {
	const own = lastGood.get(accountId);
	return own ? { ...own, source: "cached" } : null;
}

interface OpenAIModelsResponse {
	data?: Array<{ id?: string }>;
}

function normalize(body: OpenAIModelsResponse): OpenAICompatibleModelEntry[] {
	const seen = new Set<string>();
	const entries: OpenAICompatibleModelEntry[] = [];
	for (const raw of body.data ?? []) {
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		entries.push({ id, displayName: id });
	}
	return entries;
}

async function fetchLive(
	account: Account,
): Promise<OpenAICompatibleModelEntry[]> {
	if (!account.api_key) {
		throw new Error("no API key for this account");
	}
	const endpoint = validateEndpointUrl(getEndpointUrl(account), "endpoint");
	const url = `${endpoint}${endpoint.endsWith("/v1") ? "" : "/v1"}/models`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${account.api_key}`,
				accept: "application/json",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return normalize((await response.json()) as OpenAIModelsResponse);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * The family -> model map an account's own listing implies.
 *
 * There is no cross-provider priority signal on this endpoint (unlike Codex's
 * `priority` field), so position is whatever order the account's own server
 * returned — the best available signal without a table of ours to keep
 * current. A shorter list degrades to the last available model rather than
 * leaving a family unmapped.
 */
export function deriveFamilyDefaults(
	models: OpenAICompatibleModelEntry[],
): Record<string, string> {
	if (models.length === 0) return {};
	const at = (index: number): string =>
		models[Math.min(index, models.length - 1)].id;
	return {
		fable: at(0),
		opus: at(0),
		sonnet: at(1),
		haiku: at(2),
	};
}

/**
 * Make sure this account has a derived default map before anything tries to
 * map a Claude family onto one of the provider's models.
 *
 * A no-op for every other provider, and for an openai-compatible account that
 * already has one — which, after the first request, is all of them.
 */
export async function ensureOpenAICompatibleModelDefaults(
	account: Account | null | undefined,
	ctx: ProxyContext,
): Promise<void> {
	if (account?.provider !== "openai-compatible") return;
	if (hasDerivedProviderModelDefaults("openai-compatible", account.id)) return;
	try {
		await getOpenAICompatibleModels(account.id, ctx);
	} catch (err) {
		// Never blocks the request: without a map the family falls through and
		// the provider gets to say what it thinks, which the record then learns.
		log.debug(`Could not load the model list for ${account.name}: ${err}`);
	}
}

/**
 * The model list for one openai-compatible account: live when the account's
 * endpoint answers, otherwise the last list it gave us. Returns null only
 * when both are unavailable — a brand new account whose first fetch failed.
 */
export async function getOpenAICompatibleModels(
	accountId: string,
	ctx: ProxyContext,
): Promise<OpenAICompatibleModelListing | null> {
	const account = await ctx.dbOps.getAccount(accountId);
	if (!account || account.provider !== "openai-compatible") return null;

	try {
		const models = await fetchLive(account);
		if (models.length === 0) {
			throw new Error("the listing came back with no usable models");
		}
		const listing: OpenAICompatibleModelListing = {
			accountId,
			models,
			fetchedAt: Date.now(),
			source: "live",
		};
		lastGood.set(accountId, listing);
		setDerivedProviderModelDefaults(
			"openai-compatible",
			accountId,
			deriveFamilyDefaults(models),
		);
		return listing;
	} catch (error) {
		const cached = readCache(accountId);
		if (cached) {
			setDerivedProviderModelDefaults(
				"openai-compatible",
				accountId,
				deriveFamilyDefaults(cached.models),
			);
		}
		log.warn(
			`Live model list failed for ${account.name} (${error}); ` +
				(cached
					? `serving the list from ${new Date(cached.fetchedAt).toISOString()}`
					: "and there is no cached list to fall back to"),
		);
		return cached;
	}
}
