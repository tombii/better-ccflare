/**
 * Provider fallback chain for local `web_search` interception.
 *
 * Walks the enabled `search_providers` rows in priority order and returns the
 * first successful result. Success includes an empty hit list: "this provider
 * found nothing" is a valid answer and must not fall through to the next
 * provider. A throw is the only fallback trigger, and each throw records
 * provider health (plus a cooldown for credential/quota failures).
 *
 * Returning `null` is a normal outcome: the caller then lets the request go
 * upstream to Anthropic. Nothing in this module throws.
 */

import type { DatabaseOperations } from "@better-ccflare/database";
import {
	SEARCH_PROVIDER_CATALOG,
	type SearchProvider,
	type SearchProviderId,
} from "@better-ccflare/types";
import { getWebToolAdapter } from "./adapters";
import type { WebToolSearchHit, WebToolSearchRequest } from "./types";

/** Total budget across every provider attempt in one chain run. */
const CHAIN_DEADLINE_MS = 15_000;
/** Cap on the health-write message so one verbose body can't bloat the row. */
const STATUS_MESSAGE_MAX_CHARS = 200;

/** Cooldowns keyed by the HTTP status that triggered them. */
const COOLDOWN_MS_BY_STATUS: Record<number, number> = {
	401: 10 * 60_000,
	402: 30 * 60_000,
	429: 5 * 60_000,
};

type SearchProviderRepository = ReturnType<
	DatabaseOperations["getSearchProviderRepository"]
>;

export interface WebToolChainDeps {
	dbOps: Pick<DatabaseOperations, "getSearchProviderRepository">;
	/** Client-disconnect signal; aborts every in-flight and future attempt. */
	signal?: AbortSignal;
	/** Injectable clock for tests; defaults to `Date.now`. */
	now?: () => number;
	/** Optional warn sink; the chain never logs at other levels. */
	log?: { warn(msg: string): void };
}

export interface WebToolChainResult {
	hits: WebToolSearchHit[];
	providerId: SearchProviderId;
	providerLabel: string;
	/** Wall-clock time from the start of the chain to the successful result. */
	latencyMs: number;
}

/** Combine the caller's signal with this attempt's remaining budget. */
function budgetSignal(
	signal: AbortSignal | undefined,
	budgetMs: number,
): AbortSignal {
	const timeout = AbortSignal.timeout(budgetMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Pull an HTTP status off a typed adapter error, if it carries one. */
function httpStatusOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" && Number.isFinite(status)
		? status
		: undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Build the health-write message for a failure: redact the API key (even
 * though adapters should never include it), collapse whitespace and cap the
 * length so a verbose upstream body can't bloat the row.
 */
function failureMessage(error: unknown, apiKey: string | null): string {
	let message = errorMessage(error).replace(/\s+/g, " ").trim();
	if (apiKey) {
		message = message.split(apiKey).join("[redacted]");
	}
	if (!message) message = "search provider failed";
	return message.length > STATUS_MESSAGE_MAX_CHARS
		? `${message.slice(0, STATUS_MESSAGE_MAX_CHARS)}…`
		: message;
}

/** Cooldown end timestamp for credential/quota failures; null otherwise. */
function cooldownUntilFor(error: unknown, now: number): number | null {
	const status = httpStatusOf(error);
	if (status === undefined) return null;
	const cooldownMs = COOLDOWN_MS_BY_STATUS[status];
	return cooldownMs === undefined ? null : now + cooldownMs;
}

/**
 * Write health without ever letting the write fail the search. Health is
 * best-effort telemetry; the search result matters more.
 */
async function recordHealth(
	repo: SearchProviderRepository,
	id: string,
	health: {
		status: string;
		statusMessage: string | null;
		cooldownUntil: number | null;
	},
	log: WebToolChainDeps["log"],
): Promise<void> {
	try {
		await repo.updateHealth(id, health);
	} catch (error) {
		log?.warn(
			`web-search: failed to record health for provider ${id}: ${errorMessage(error)}`,
		);
	}
}

/** Whether the catalog says this provider cannot work without a key. */
function requiresKey(providerId: SearchProviderId): boolean {
	return (
		SEARCH_PROVIDER_CATALOG.find((entry) => entry.id === providerId)
			?.requiresKey === true
	);
}

/**
 * Run the search through the configured providers in priority order.
 *
 * Returns `null` when no provider is eligible or every attempt failed — the
 * caller then falls through to the upstream Anthropic call.
 */
export async function runWebSearchChain(
	deps: WebToolChainDeps,
	request: WebToolSearchRequest,
): Promise<WebToolChainResult | null> {
	const now = deps.now ?? Date.now;
	const startedAt = now();
	const deadline = startedAt + CHAIN_DEADLINE_MS;
	const log = deps.log;

	let repo: SearchProviderRepository;
	let providers: SearchProvider[];
	try {
		repo = deps.dbOps.getSearchProviderRepository();
		// Full model: this is the only path that carries the plaintext key.
		providers = await repo.listActiveByPriority();
	} catch (error) {
		log?.warn(
			`web-search: failed to load search providers: ${errorMessage(error)}`,
		);
		return null;
	}

	for (const provider of providers) {
		if (deps.signal?.aborted) return null;

		const current = now();
		if (current >= deadline) break;

		// A provider cooling down after a recent failure is skipped until the
		// timestamp passes — no attempt, no health write.
		if (provider.cooldownUntil !== null && provider.cooldownUntil > current) {
			continue;
		}

		const adapter = getWebToolAdapter(provider.provider);
		if (!adapter || adapter.implemented === false) continue;

		if (requiresKey(provider.provider) && !provider.apiKey) continue;

		const remainingMs = deadline - current;
		if (remainingMs <= 0) break;

		try {
			const hits = await adapter.search(
				{ ...request, signal: budgetSignal(deps.signal, remainingMs) },
				{
					apiKey: provider.apiKey,
					maxResults: provider.maxResults,
					extraConfig: provider.extraConfig,
				},
			);

			await recordHealth(
				repo,
				provider.id,
				{ status: "ok", statusMessage: null, cooldownUntil: null },
				log,
			);

			return {
				hits,
				providerId: provider.provider,
				providerLabel: provider.label,
				latencyMs: now() - startedAt,
			};
		} catch (error) {
			const failedAt = now();
			const message = failureMessage(error, provider.apiKey);
			const cooldownUntil = cooldownUntilFor(error, failedAt);

			log?.warn(
				`web-search: provider ${provider.provider} (${provider.label}) failed: ${message}`,
			);

			await recordHealth(
				repo,
				provider.id,
				{ status: "error", statusMessage: message, cooldownUntil },
				log,
			);
			// Fall through to the next provider.
		}
	}

	return null;
}
