import { Logger } from "@better-ccflare/logger";
import {
	CODEX_VERSION,
	hasDerivedProviderModelDefaults,
	setDerivedProviderModelDefaults,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers/proxy-types";
import { getValidAccessToken } from "./handlers/token-manager";

const log = new Logger("CodexModelCatalog");

/**
 * Models a Codex account can actually call, straight from OpenAI.
 *
 * `api.openai.com/v1/models` is the documented listing, and it is the WRONG
 * question here: it answers for API-key organisations and returns HTTP 403
 * (`Missing scopes: api.model.read`) for a ChatGPT-subscription token. The
 * endpoint below is what the Codex CLI itself calls, and it answers per
 * subscription — measured against a real account, `gpt-5.3-codex` is absent
 * from it, which is exactly the model whose refusal started this whole line of
 * work.
 *
 * It is not part of OpenAI's public REST reference, so it is treated as
 * best-effort: every success is written to disk, and a later failure serves the
 * last known-good list rather than a generic catalogue that would happily list
 * models this plan cannot call.
 */
export interface CodexModelEntry {
	id: string;
	displayName: string;
	description: string | null;
	contextWindow: number | null;
	/**
	 * Model OpenAI says will replace this one, when it has announced a
	 * deprecation. Worth surfacing: picking a model that is on its way out is
	 * a decision someone will have to undo.
	 */
	supersededBy: string | null;
}

export interface CodexModelListing {
	accountId: string;
	models: CodexModelEntry[];
	fetchedAt: number;
	/**
	 * "live" straight from OpenAI, "cached" this account's own earlier read,
	 * "shared" another account of the same provider — see the note on
	 * providerWide below.
	 */
	source: "live" | "cached" | "shared";
	/** Account the list actually came from, when it was not this one. */
	borrowedFrom?: string;
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Last good listing per account, for this process only.
 *
 * Deliberately not written to disk: a snapshot that outlives the process is a
 * second place where the truth can quietly go stale. A failed refresh keeps
 * serving what is already here; a restart starts empty and stays empty until
 * a read succeeds, which is honest about what is actually known.
 */
const lastGood = new Map<string, CodexModelListing>();

/**
 * The last listing any account of this provider managed to read.
 *
 * Two of three measured accounts answer HTTP 401 on the models endpoint while
 * serving traffic perfectly — for them, their own list will never exist. Login
 * accounts of one provider generally see the same models, so one account's
 * read is a far better answer than nothing.
 *
 * "Generally" is doing work in that sentence: the provider's payload carries
 * `available_in_plans`, so different plans can differ. A borrowed list is
 * therefore labelled as borrowed rather than passed off as this account's own.
 */
let providerWide: CodexModelListing | null = null;

/** Test seam: both registries are process-wide and leak between cases. */
export function clearCodexModelCacheForTests(): void {
	lastGood.clear();
	providerWide = null;
}

function readCache(accountId: string): CodexModelListing | null {
	const own = lastGood.get(accountId);
	if (own) return { ...own, source: "cached" };
	// Nothing of this account's own: fall back to whatever another account of
	// the same provider read, labelled so nobody mistakes it for this one's.
	if (providerWide) {
		return {
			...providerWide,
			accountId,
			source: "shared",
			borrowedFrom: providerWide.accountId,
		};
	}
	return null;
}

function writeCache(listing: CodexModelListing): void {
	lastGood.set(listing.accountId, listing);
	providerWide = listing;
}

interface CodexModelsResponse {
	models?: Array<{
		slug?: string;
		display_name?: string;
		description?: string;
		context_window?: number;
		/** "list" to be offered; "hide" for routing aliases and internal models. */
		visibility?: string;
		/** OpenAI's own ordering, frontier first. */
		priority?: number;
		upgrade?: { model?: string } | null;
	}>;
}

function normalize(body: CodexModelsResponse): CodexModelEntry[] {
	const seen = new Set<string>();
	const entries: Array<CodexModelEntry & { priority: number }> = [];
	for (const raw of body.models ?? []) {
		const id = typeof raw.slug === "string" ? raw.slug.trim() : "";
		if (!id || seen.has(id)) continue;

		// OpenAI marks what is meant to be offered. Two of the eight entries a
		// live account returns are `hide`: a Work Mode routing alias and the
		// automatic review model — neither is something to pick in a mapping.
		// Reading the flag rather than matching on the name means the next alias
		// OpenAI ships is excluded without anyone learning its suffix.
		if (raw.visibility && raw.visibility !== "list") continue;

		seen.add(id);
		entries.push({
			id,
			priority: typeof raw.priority === "number" ? raw.priority : 1_000,
			supersededBy:
				typeof raw.upgrade?.model === "string" ? raw.upgrade.model : null,
			displayName:
				typeof raw.display_name === "string" && raw.display_name.trim()
					? raw.display_name
					: id,
			description:
				typeof raw.description === "string" && raw.description.trim()
					? raw.description
					: null,
			contextWindow:
				typeof raw.context_window === "number" ? raw.context_window : null,
		});
	}

	// OpenAI's own ordering puts the frontier models first; alphabetical would
	// open the list with `codex-auto-review` and `gpt-5.4-mini`.
	return entries
		.sort((a, b) => a.priority - b.priority)
		.map(({ priority: _priority, ...entry }) => entry);
}

/**
 * One live call for one account. The token comes from the normal refresh path,
 * because a stored access token is routinely stale — measured: two of three
 * accounts answered 401 with the token as stored, and 200 once refreshed.
 */
async function fetchLive(
	account: Account,
	ctx: ProxyContext,
): Promise<CodexModelEntry[]> {
	const accessToken = await getValidAccessToken(account, ctx);
	if (!accessToken) throw new Error("no access token for this account");

	const url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(CODEX_VERSION)}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: "application/json",
				// The endpoint rejects the request without a client version, and
				// identifies the caller by originator — mirroring the CLI keeps us
				// on the path OpenAI actually serves.
				originator: "codex_cli_rs",
				"user-agent": `codex_cli_rs/${CODEX_VERSION}`,
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return normalize((await response.json()) as CodexModelsResponse);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Make sure this account has a derived default map before anything tries to
 * map a Claude family onto one of the provider's models.
 *
 * A no-op for every other provider, and for a codex account that already has
 * one — which, after the first request, is all of them.
 */
export async function ensureCodexModelDefaults(
	account: Account | null | undefined,
	ctx: ProxyContext,
): Promise<void> {
	if (account?.provider !== "codex") return;
	if (hasDerivedProviderModelDefaults("codex", account.id)) return;
	try {
		await getCodexModels(account.id, ctx);
	} catch (err) {
		// Never blocks the request: without a map the family falls through and
		// the provider gets to say what it thinks, which the record then learns.
		log.debug(`Could not load the model list for ${account.name}: ${err}`);
	}
}

/**
 * The family -> model map an account's own listing implies.
 *
 * The listing arrives ordered by the provider's `priority`, so position IS
 * the tier and there is no table of ours to keep current: whatever OpenAI
 * promotes to the top becomes the frontier default by itself.
 *
 * `opus` and `fable` take the frontier model, `sonnet` the next one and
 * `haiku` the one after — matching what each Anthropic family is for. A
 * shorter list degrades to the last available model rather than leaving a
 * family unmapped, because an unmapped family falls through to the Claude
 * name and the provider answers 400.
 */
export function deriveFamilyDefaults(
	models: CodexModelEntry[],
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
 * The frontier model of a listing, or null when there is no listing to read.
 *
 * Same rule as the `opus`/`fable` mapping four lines up: the listing arrives in
 * the provider's own `priority` order, so position IS the tier and nothing of
 * ours has to be kept current. Anyone who needs "the best model this account
 * can call" — the usage probe included — asks here instead of hardcoding a name
 * that goes stale the next time OpenAI promotes something.
 */
export function topTierCodexModel(
	listing: CodexModelListing | null | undefined,
): string | null {
	const models = listing?.models ?? [];
	return models.length > 0 ? models[0].id : null;
}

/**
 * The model list for one Codex account: live when OpenAI answers, otherwise the
 * last list it gave us. Returns null only when both are unavailable — a brand
 * new account whose first fetch failed.
 */
export async function getCodexModels(
	accountId: string,
	ctx: ProxyContext,
): Promise<CodexModelListing | null> {
	const account = await ctx.dbOps.getAccount(accountId);
	if (!account || account.provider !== "codex") return null;

	try {
		const models = await fetchLive(account, ctx);
		// An answer with nothing usable in it is not an answer. Recording it
		// would mark the account as resolved and stop every later attempt, so a
		// single odd response would freeze the account with no defaults at all.
		if (models.length === 0) {
			throw new Error("the listing came back with no usable models");
		}
		const listing: CodexModelListing = {
			accountId,
			models,
			fetchedAt: Date.now(),
			source: "live",
		};
		// Kept before returning, so a later failure still has something to serve.
		writeCache(listing);
		setDerivedProviderModelDefaults(
			"codex",
			accountId,
			deriveFamilyDefaults(models),
		);
		return listing;
	} catch (error) {
		const cached = readCache(accountId);
		// The cached listing is still this account's own answer, just an older
		// one — far better than a map compiled months ago.
		if (cached) {
			setDerivedProviderModelDefaults(
				"codex",
				accountId,
				deriveFamilyDefaults(cached.models),
			);
		}
		log.warn(
			`Live Codex model list failed for ${account.name} (${error}); ` +
				(cached
					? `serving the list from ${new Date(cached.fetchedAt).toISOString()}`
					: "and there is no cached list to fall back to"),
		);
		return cached;
	}
}
