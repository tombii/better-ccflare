/**
 * Provider fallback chain for local `web_search` interception.
 *
 * Walks the enabled `search_providers` rows in priority order and returns the
 * first successful result. Success includes an empty hit list: "this provider
 * found nothing" is a valid answer and must not fall through to the next
 * provider. A throw is the only fallback trigger, and each throw records
 * provider health (plus a cooldown for credential/quota failures).
 *
 * A failed outcome is a normal result: the caller then lets the request go
 * upstream to Anthropic. The outcome records whether any provider was
 * attempted, so the caller can tell "nothing eligible" from "all failed".
 * Nothing in this module throws.
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
	/** Provider kind (which adapter / catalog entry served the search). */
	providerId: SearchProviderId;
	/** `search_providers.id` of the row that served it. */
	providerRowId: string;
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

/**
 * Short machine code for a failed attempt, safe to persist in the trace row.
 *
 * The full message is fine for the health column and the log, but the trace
 * table is long-lived and exported; provider response bodies belong there
 * only after being reduced to something that cannot carry credentials or
 * arbitrary upstream text. `tvly_401` says everything an operator needs.
 */
function failureCode(error: unknown, providerId: SearchProviderId): string {
	const status =
		typeof (error as { status?: unknown })?.status === "number"
			? (error as { status: number }).status
			: null;
	return status === null ? `${providerId}_error` : `${providerId}_${status}`;
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
/**
 * Health is display-only state for the dashboard. A write must never sit on
 * the search's critical path: the SQLite adapter retries a BUSY write for up
 * to ten minutes, which would hold a completed search (or block the fallback
 * to the next provider) long past the chain deadline. The write is fired in
 * the background and its failure is only logged.
 */
function recordHealth(
	repo: SearchProviderRepository,
	id: string,
	health: {
		status: string;
		statusMessage: string | null;
		cooldownUntil: number | null;
	},
	log: WebToolChainDeps["log"],
): void {
	void repo.updateHealth(id, health).catch((error: unknown) => {
		log?.warn(
			`web-search: failed to record health for provider ${id}: ${errorMessage(error)}`,
		);
	});
}

/** Whether the catalog says this provider cannot work without a key. */
function requiresKey(providerId: SearchProviderId): boolean {
	return (
		SEARCH_PROVIDER_CATALOG.find((entry) => entry.id === providerId)
			?.requiresKey === true
	);
}

/**
 * Why a chain run did not produce a result. `no_provider` means nothing was
 * ever attempted (nothing configured, or every row skipped); `all_failed`
 * means at least one provider was called and every attempt threw.
 */
export type WebToolChainFailureReason = "no_provider" | "all_failed";

/** Outcome of one chain run: served, or not — with the reason kept. */
export type WebToolChainOutcome =
	| ({ ok: true } & WebToolChainResult)
	| {
			ok: false;
			reason: WebToolChainFailureReason;
			/** Providers actually called (0 when `reason` is `no_provider`). */
			attemptedCount: number;
			/** Provider kind of the last failed attempt, null if none. */
			lastProviderId: SearchProviderId | null;
			/**
			 * `search_providers.id` of the last failed attempt. With several
			 * rows of the same kind configured, the kind alone cannot say which
			 * one failed.
			 */
			lastProviderRowId: string | null;
			/** Redacted, length-capped message from the last failed attempt. */
			lastErrorMessage: string | null;
			/**
			 * Short machine code for the last failed attempt (e.g. `tavily_401`).
			 * This — not the message — is what gets persisted in the trace row:
			 * the trace is long-lived and exported, and a provider response body
			 * does not belong there.
			 */
			lastErrorCode: string | null;
			/** Wall-clock time from the start of the chain to giving up. */
			latencyMs: number;
	  };

/** Narrow an outcome to the `ok: false` branch. */
export function isChainFailure(
	outcome: WebToolChainOutcome,
): outcome is Extract<WebToolChainOutcome, { ok: false }> {
	return !outcome.ok;
}

/**
 * Run the search through the configured providers in priority order.
 *
 * Never throws. A failed outcome tells the caller whether anything was
 * attempted, so it can tell "nothing eligible" (fall through, not a search
 * failure) from "every provider failed" (a search error).
 */
export async function runWebSearchChain(
	deps: WebToolChainDeps,
	request: WebToolSearchRequest,
): Promise<WebToolChainOutcome> {
	const now = deps.now ?? Date.now;
	const startedAt = now();
	const deadline = startedAt + CHAIN_DEADLINE_MS;
	const log = deps.log;
	let attemptedCount = 0;
	let lastProviderId: SearchProviderId | null = null;
	let lastProviderRowId: string | null = null;
	let lastErrorMessage: string | null = null;
	let lastErrorCode: string | null = null;

	const giveUp = (reason: WebToolChainFailureReason): WebToolChainOutcome => ({
		ok: false,
		reason,
		attemptedCount,
		lastProviderId: reason === "no_provider" ? null : lastProviderId,
		lastProviderRowId: reason === "no_provider" ? null : lastProviderRowId,
		lastErrorMessage: reason === "no_provider" ? null : lastErrorMessage,
		lastErrorCode: reason === "no_provider" ? null : lastErrorCode,
		latencyMs: now() - startedAt,
	});

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
		return giveUp("no_provider");
	}

	for (const provider of providers) {
		if (deps.signal?.aborted) break;

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

		attemptedCount += 1;
		lastProviderId = provider.provider;
		lastProviderRowId = provider.id;
		try {
			const hits = await adapter.search(
				{ ...request, signal: budgetSignal(deps.signal, remainingMs) },
				{
					apiKey: provider.apiKey,
					maxResults: provider.maxResults,
					extraConfig: provider.extraConfig,
					rowId: provider.id,
				},
			);

			recordHealth(
				repo,
				provider.id,
				{ status: "ok", statusMessage: null, cooldownUntil: null },
				log,
			);

			return {
				ok: true,
				hits,
				providerId: provider.provider,
				providerRowId: provider.id,
				providerLabel: provider.label,
				latencyMs: now() - startedAt,
			};
		} catch (error) {
			const failedAt = now();
			const message = failureMessage(error, provider.apiKey);
			lastErrorCode = failureCode(error, provider.provider);
			const cooldownUntil = cooldownUntilFor(error, failedAt);
			lastErrorMessage = message;

			log?.warn(
				`web-search: provider ${provider.provider} (${provider.label}) failed: ${message}`,
			);

			recordHealth(
				repo,
				provider.id,
				{ status: "error", statusMessage: message, cooldownUntil },
				log,
			);
			// Fall through to the next provider.
		}
	}

	return giveUp(attemptedCount > 0 ? "all_failed" : "no_provider");
}
