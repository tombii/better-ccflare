import {
	type AccountUsageSnapshot,
	requestEvents,
	runForceAccountModelExempt,
	ServiceUnavailableError,
	type SpendLimitExceededEvt,
	spendLimitEvents,
	splitModelRouting,
	trackClientVersion,
} from "@better-ccflare/core";
import { DatabaseFactory } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import {
	deriveXaiConvId,
	getProvider,
	getRepresentativeUsageSnapshotForProvider,
	isOfficialXaiEndpoint,
	type RequestObservation,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	ApiKeyRestrictions,
	ApiKeySpendLimit,
} from "@better-ccflare/types";
import { cacheBodyStore } from "./cache-body-store";
import {
	createModelFamilyExhaustedResponse,
	createPoolExhaustedResponse,
	createRequestMetadata,
	createUsageThrottledResponse,
	ERROR_MESSAGES,
	getAccountUsageThrottleUntil,
	getApiKeyRestrictionDenial,
	getApiKeySpendCounter,
	getComboSlotInfo,
	getDeferredCandidates,
	getModelFamilyExhaustionInfo,
	interceptAndModifyRequest,
	isComboSessionFallbackDisabled,
	isForceAccountModelEnabled,
	isInternalProbe,
	isModelAllowedForApiKey,
	isRefreshTokenLikelyExpired,
	isVisionUnsupported,
	markTrustedNativeResponses,
	type ProxyContext,
	prepareRequestBody,
	proxyUnauthenticated,
	proxyWithAccount,
	RequestBodyContext,
	type RequestJsonBody,
	recordSelectedOrder,
	recordXaiAffinitySuccess,
	requestCarriesImageContent,
	resolveEffectiveModel,
	restrictsModels,
	type SpendSnapshot,
	selectAccountsForRequest,
	setXaiConvId,
	validateProviderPath,
} from "./handlers";
import {
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
	wouldSuppressProbe,
} from "./handlers/rate-limit-cooldown";
import { extractProjectAttributionFromRequest } from "./project-attribution";
import {
	buildSessionRejectResponse,
	recordSessionRequest,
} from "./session-governor";
import {
	getUsageCollector,
	initUsageCollector,
	tryGetUsageCollector,
	type UsageCollectorHealth,
} from "./usage-collector";
import { maybeInterceptWebSearch } from "./web-tools/intercept";

export type { ProxyContext } from "./handlers";

const log = new Logger("Proxy");

function createComboSessionFallbackDisabledResponse(
	comboName: string,
): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				// Listed in LOCAL_REFUSAL_ERROR_TYPES — the auto-refresh scheduler
				// recognises this shape as a local refusal, so keep the two in sync.
				type: "service_unavailable_error",
				message: "Service temporarily unavailable. Please try again later.",
				code: "combo_session_fallback_disabled",
				combo: comboName,
			},
		}),
		{
			status: 503,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/**
 * No account can serve the model that was asked for, and "force account model"
 * forbids serving a different one.
 *
 * 503 rather than 400: the request is well formed, and the same model may well
 * be servable in a minute — an account may be rate-limited right now, or its
 * model listing not yet read. The model is named in the body because that is
 * the one thing the caller can act on.
 */
function createForceAccountModelResponse(model: string): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				// Listed in LOCAL_REFUSAL_ERROR_TYPES — the auto-refresh scheduler
				// recognises this shape as a local refusal, so keep the two in sync.
				type: "service_unavailable_error",
				message: `No available account can serve "${model}", and forcing the account model is enabled so no substitute was used.`,
				code: "force_account_model_no_account",
				model,
			},
		}),
		{
			status: 503,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/**
 * The Anthropic-compatible envelope for a refusal caused by an API key's own
 * restrictions.
 *
 * 403 with `type: "permission_error"`: that is the type the Anthropic Messages
 * API uses for 403, and these responses go straight back to Claude Code
 * clients, which read the envelope. (The repo's other 403, at
 * apps/server/src/server.ts, says `authorization_error` — but that one sits on
 * the management/authorization path guarding dashboard endpoints by key role,
 * not on `/v1/messages`, where the promise is to look like Anthropic.)
 *
 * 403 and not 503: nothing about this is temporary and no retry will change it,
 * so it must not carry the retry semantics the capacity refusals carry.
 */
function createApiKeyRestrictionResponse(
	code: "api_key_model_restricted" | "api_key_account_restricted",
	message: string,
	extra: Record<string, unknown> = {},
): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "permission_error",
				code,
				message,
				...extra,
			},
		}),
		{
			status: 403,
			headers: { "Content-Type": "application/json" },
		},
	);
}

// Same numbers, same meaning, as handlers/model-capacity.ts's
// DEFAULT_RETRY_AFTER_SECONDS / MAX_RETRY_AFTER_SECONDS, which are module-
// private there. Re-declared rather than exported across the module boundary
// so the two refusals can be read side by side; if either moves, both should.
const SPEND_LIMIT_DEFAULT_RETRY_AFTER_SECONDS = 60;
const SPEND_LIMIT_MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * The Anthropic-compatible envelope for a refusal caused by an API key's own
 * spend limit.
 *
 * 429 with `type: "rate_limit_error"`, NOT the 403 `permission_error` its
 * sibling above uses: a spend limit is a rate that resets, and a client that
 * waits does eventually get served again — which is exactly what 429 plus
 * Retry-After tells it. A 403 would tell a client to stop trying forever.
 *
 * The clamp on Retry-After is lifted verbatim from
 * handlers/model-capacity.ts's `createModelFamilyExhaustedResponse`, which
 * reuses those two constants: at least 1 second, at most an hour, and the
 * 60-second default when no reset is known. The upper clamp matters here —
 * a calendar-month window can be four weeks out, and handing a client a
 * `Retry-After: 2419200` is not a useful instruction.
 */
function createApiKeySpendLimitResponse(info: {
	limitUsd: number;
	spentUsd: number;
	window: string;
	resetMs: number | null;
}): Response {
	const retryAfterSeconds =
		info.resetMs != null && info.resetMs > Date.now()
			? Math.max(
					1,
					Math.min(
						SPEND_LIMIT_MAX_RETRY_AFTER_SECONDS,
						Math.ceil((info.resetMs - Date.now()) / 1000),
					),
				)
			: SPEND_LIMIT_DEFAULT_RETRY_AFTER_SECONDS;

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				code: "api_key_limit_exceeded",
				message: `This API key has exceeded its spend limit of $${info.limitUsd} over its ${info.window} window ($${info.spentUsd.toFixed(4)} spent).`,
				limit_usd: info.limitUsd,
				spent_usd: info.spentUsd,
				window: info.window,
				resets_at:
					info.resetMs != null ? new Date(info.resetMs).toISOString() : null,
			},
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
			},
		},
	);
}

// ===== USAGE COLLECTOR MANAGEMENT =====

export async function initProxy(
	getStorePayloads: () => boolean,
): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	await initUsageCollector(
		getStorePayloads,
		(summary) => {
			requestEvents.emit("event", { type: "summary", payload: summary });
		},
		dbOps,
	);
	// Seed one spend total per key that has a limit, so the very first request
	// after a restart is checked against the real spend rather than zero. Keys
	// with no limit are not listed and get no counter. Failures inside seedAll
	// are logged and swallowed — a key that could not be seeded here seeds
	// lazily (and synchronously) the first time it is checked.
	await getApiKeySpendCounter(dbOps).seedAll();
}

export async function drainUsageCollector(): Promise<void> {
	return tryGetUsageCollector()?.drain() ?? Promise.resolve();
}

export function getUsageCollectorHealth(): UsageCollectorHealth {
	return tryGetUsageCollector()?.getHealth() ?? { state: "ready" };
}

// ===== MAIN HANDLER =====

/**
 * Main proxy handler - orchestrates the entire proxy flow
 *
 * This function coordinates the proxy process by:
 * 1. Creating request metadata for tracking
 * 2. Validating the provider can handle the path
 * 3. Preparing the request body for reuse
 * 4. Selecting accounts based on load balancing strategy
 * 5. Attempting to proxy with each account in order
 * 6. Falling back to unauthenticated proxy if no accounts available
 *
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param ctx - The proxy context containing strategy, database, and provider
 * @param apiKeyId - Optional API key ID for tracking
 * @param apiKeyName - Optional API key name for tracking
 * @returns Promise resolving to the proxied response
 * @throws {ValidationError} If the provider cannot handle the path
 * @throws {ServiceUnavailableError} If all accounts fail to proxy the request
 * @throws {ProviderError} If unauthenticated proxy fails
 */
/**
 * A verified internal probe runs with `force_account_model` treated as off for
 * its whole lifetime.
 *
 * The switch promises to serve the model the *client* named or nothing, and a
 * probe is not a client: the schedulers send a compiled-in list of Claude ids
 * to whatever account they are probing, because the point is to touch the
 * endpoint and read the answer. Mapping is what makes that land on a non-Claude
 * account, so leaving the switch on here would not honour the promise — it
 * would send `claude-haiku-4-5` to Codex, take the rejection as a refresh
 * failure, and pause a healthy account after five of them.
 *
 * `isInternalProbe` verifies the process-local probe secret, so a client that
 * copies the marker header out of a log gets nothing. Sibling of the exemptions
 * probes already have in usage throttling and in the forced-account model
 * check.
 */
export function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	options?: {
		trustedNativeResponses?: boolean;
		/**
		 * The authenticated API key's account / model / provider allowlists,
		 * resolved by the caller (apps/server/src/server.ts) from the key
		 * record it already holds, so enforcement costs no extra DB read on the
		 * hot path. `null`/absent means unrestricted — which is also what
		 * zero-keys mode produces, since no key record exists there at all.
		 */
		restrictions?: ApiKeyRestrictions | null;
		/**
		 * The authenticated API key's spend limit, resolved by the caller from
		 * the same key record for the same reason. `null`/absent means no limit
		 * — which is also what zero-keys mode produces, since there is no key
		 * there at all and so nothing to charge a budget to.
		 */
		spendLimit?: ApiKeySpendLimit | null;
	},
): Promise<Response> {
	let observation: RequestObservation | undefined;
	try {
		if (url.pathname === "/v1/messages" || url.pathname === "/v1/responses") {
			// The protocol default can be Anthropic before account selection, even
			// in a dedicated Codex process. The registered observer gates itself
			// on the explicit process-wide diagnostics switch.
			const observerProvider = ctx.provider.observeRequest
				? ctx.provider
				: getProvider("codex");
			observation = observerProvider?.observeRequest?.(
				req.headers,
				options?.trustedNativeResponses === true,
			);
		}
	} catch {
		log.warn("Request observation failed", { capture_gap: true });
	}
	const run = () =>
		handleProxyRequest(
			req,
			url,
			ctx,
			apiKeyId,
			apiKeyName,
			options,
			observation,
		);
	const result = isInternalProbe(req.headers, ctx)
		? runForceAccountModelExempt(run)
		: run();
	if (!observation) return result;
	return result.then(
		(response) => {
			try {
				observation.response(response);
			} catch {
				log.warn("Request observation failed", { capture_gap: true });
			}
			return response;
		},
		(error) => {
			try {
				observation.error(error);
			} catch {
				log.warn("Request observation failed", { capture_gap: true });
			}
			throw error;
		},
	);
}

async function handleProxyRequest(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	options?: {
		trustedNativeResponses?: boolean;
		restrictions?: ApiKeyRestrictions | null;
		spendLimit?: ApiKeySpendLimit | null;
	},
	observation?: RequestObservation,
): Promise<Response> {
	// 0. Silently ignore Claude Code internal endpoints (non-critical, not supported by all providers)
	if (
		url.pathname === "/api/event_logging/batch" ||
		url.pathname === "/api/system/package-manager"
	) {
		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// 1. Track client version from user-agent for use in auto-refresh
	trackClientVersion(req.headers.get("user-agent"));

	// 2. Validate provider can handle path
	validateProviderPath(ctx.provider, url.pathname);

	// 3. Prepare request body
	const { buffer: requestBodyBuffer } = await prepareRequestBody(req);
	const requestBodyContext = new RequestBodyContext(requestBodyBuffer);

	// 3b. Optionally inject 1h TTL into system prompt cache_control blocks
	if (ctx.config.getSystemPromptCacheTtl1h() && requestBodyBuffer) {
		injectSystemCacheTtl(requestBodyContext);
	}

	// Extract model from request body for family detection (used by combo routing)
	// and reuse parsed body for /v1/messages validation (consolidate parses)
	const parsedBody = requestBodyContext.getParsedJson();
	const requestModel = requestBodyContext.getModel();
	const { project, projectAttributionSource } =
		extractProjectAttributionFromRequest(req.headers, parsedBody);

	// Seam 5 — per-API-key model allowlist, EVALUATED HERE.
	//
	// This is the last point at which the model is the one the client actually
	// asked for: the agent interceptor below rewrites it (agent preference),
	// and combo slots override it again during selection. Enforcing on the
	// client-requested model is the whole promise — it is the only thing a key
	// holder can reason about, and a key restricted to "haiku" must not be
	// denied because an agent preference silently upgraded the request to opus.
	// Server-side rewrites are explicitly OUT OF SCOPE of this restriction.
	//
	// Internal probes are exempt: the schedulers send a compiled-in list of
	// Claude model ids with no API key at all, and a probe answered with a
	// refusal counts as a refresh failure — five of those pause a healthy
	// account. `isInternalProbe` verifies the process-local probe secret.
	// (Sibling of the exemptions in usage throttling and the forced-account
	// model check.)
	//
	// The refusal itself is EMITTED further down, at the first point where
	// `returnRefusal` is in scope: a refusal that vanishes without being
	// recorded would leave the dashboard showing a quiet, healthy proxy while
	// clients get 403s. Nothing between here and there contacts an upstream
	// (the local web_search interception is skipped for a denied request).
	const keyRestrictions =
		options?.restrictions && !isInternalProbe(req.headers, ctx)
			? options.restrictions
			: null;
	const modelRestrictionDenied =
		restrictsModels(keyRestrictions) &&
		!isModelAllowedForApiKey(requestModel, keyRestrictions);

	// Per-API-key spend limit — EVALUATED HERE, for the same reasons the model
	// allowlist above is: this is before any upstream contact and before any
	// routing work, and the refusal is EMITTED further down where
	// `returnRefusal` is in scope so it is recorded as a request.
	//
	// The same two carve-outs apply, verbatim:
	//   - internal probes are exempt (`keyRestrictions` is gated on
	//     `isInternalProbe` above; this reuses the same gate). A probe carries
	//     no API key, and refusing one counts as a refresh failure — five of
	//     those pause a healthy account.
	//   - zero-key mode is a no-op: with no active keys there is no auth, no
	//     key record and no `spendLimit`, so this is `null` and nothing runs.
	//
	// This awaits the counter, which awaits the database ONLY on the first
	// call for a key (see SPEND_RESYNC_TTL_MS). Every later call is answered
	// from memory with any refresh fired into the background.
	const keySpendLimit =
		options?.spendLimit && !isInternalProbe(req.headers, ctx)
			? options.spendLimit
			: null;
	let spendSnapshot: SpendSnapshot | null = null;
	if (keySpendLimit && apiKeyId) {
		try {
			spendSnapshot = await getApiKeySpendCounter(ctx.dbOps).getSnapshot(
				apiKeyId,
				keySpendLimit,
			);
		} catch (error) {
			// Fail OPEN on a counter error, unlike the restriction checks which
			// fail closed. A spend limit is a budget control, not an access
			// control: a database hiccup must not turn into a proxy-wide outage
			// for every key that has a budget. The next request re-tries the
			// sync, and the overshoot is bounded by how long the failure lasts.
			log.warn(
				`Spend limit check failed for key ${apiKeyName ?? apiKeyId}; allowing the request: ${(error as Error).message}`,
			);
		}
	}
	const spendLimitExceeded = spendSnapshot?.exceeded === true;

	// 3a. Validate request body for /v1/messages endpoint
	if (url.pathname === "/v1/messages" && requestBodyBuffer) {
		if (parsedBody) {
			// Reject requests without messages field (e.g., Claude Code internal events)
			if (!parsedBody.messages || !Array.isArray(parsedBody.messages)) {
				log.warn(
					`Rejected invalid request to /v1/messages without messages field`,
					{
						event_type: parsedBody.event_type,
						event_name: (
							parsedBody.event_data as Record<string, unknown> | undefined
						)?.event_name,
					},
				);
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message:
								"messages: Field required for /v1/messages endpoint. Internal events should not be proxied.",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		} else {
			// If we can't parse the body, let it through and let the provider handle it
			log.debug("Could not parse request body for validation");
		}
	}

	// 3d. Serve `web_search` helper requests locally when a provider is configured.
	// A null result means "not a search request" or "no provider could serve it",
	// and the request continues upstream unchanged.
	//
	// Skipped when the API key may not use the requested model (seam 5) or is
	// over a blocking spend limit: the local search path would otherwise
	// serve — and spend search-provider quota on — a request the key is about
	// to be refused for.
	const keyRefusalPending =
		modelRestrictionDenied ||
		(spendLimitExceeded && keySpendLimit?.limitEnforce === "block");
	if (parsedBody && !keyRefusalPending) {
		const webSearchResponse = await maybeInterceptWebSearch({
			body: parsedBody,
			pathname: url.pathname,
			headers: req.headers,
			config: ctx.config,
			dbOps: ctx.dbOps,
			signal: req.signal,
			// No account is selected yet on this path, so accountId stays null
			// for every trace recorded here.
			project,
			log,
		});
		if (webSearchResponse) return webSearchResponse;
	}

	// 4. Intercept and modify request for agent model preferences
	const {
		modifiedBody,
		agentUsed,
		originalModel,
		appliedModel,
		agentAttributionSource,
	} = await interceptAndModifyRequest(
		requestBodyContext,
		ctx.dbOps,
		req.headers,
		{
			frontmatterModelFallback: ctx.config.getAgentFrontmatterModelFallback(),
			forceAccountModel: isForceAccountModelEnabled(ctx),
		},
	);

	// Use modified body if available
	const finalBodyBuffer = modifiedBody || requestBodyContext.getBuffer();
	const finalCreateBodyStream = () => {
		if (!finalBodyBuffer) return undefined;
		return new Response(finalBodyBuffer).body ?? undefined;
	};

	if (agentUsed && originalModel !== appliedModel) {
		log.info(
			`Agent ${agentUsed} detected, model changed from ${originalModel} to ${appliedModel}`,
		);
	}

	// 5. Create request metadata with agent info
	const requestMeta = createRequestMetadata(req, url);
	try {
		observation?.bindRequestId(requestMeta.id);
	} catch {
		log.warn("Request observation failed", { capture_gap: true });
	}
	if (options?.trustedNativeResponses === true) {
		markTrustedNativeResponses(requestMeta);
	}
	requestMeta.agentUsed = agentUsed;
	requestMeta.agentAttributionSource = agentAttributionSource;
	requestMeta.project = project;
	requestMeta.projectAttributionSource = projectAttributionSource;
	requestMeta.clientSessionId = requestBodyContext.getClientId();
	requestMeta.originalModel = originalModel;
	requestMeta.appliedModel = appliedModel;

	// xAI cache-native conversation identity (issue #319 minimal slice):
	// derive once per request and stash on the RequestMeta-keyed side channel
	// (see account-selector.ts) rather than widening RequestMeta's shape.
	// deriveXaiConvId is a no-op (returns null) unless CCFLARE_XAI_CACHE_NATIVE
	// is exactly "1" and clientSessionId is a valid session UUID, so this is
	// byte-for-byte a no-op when the feature is disabled.
	const xaiConvId = deriveXaiConvId(requestMeta.clientSessionId);
	if (xaiConvId) {
		setXaiConvId(requestMeta, xaiConvId);
	}

	// 5b. Session volume circuit breaker: a runaway subagent storm shows up as
	// one client session hammering /v1/messages. Count it here and, when
	// enforcement is enabled, reject before account selection burns upstream
	// quota. All identified traffic is counted: header-based exemptions would
	// be client-forgeable, and internal synthetic requests either carry no
	// client session (refresh probes, anonymous and thus ungoverned) or spend
	// upstream quota like any other request (keepalive replays) and belong in
	// the budget. This is a runaway-loop breaker, not an authentication
	// boundary: a client that omits session metadata entirely is out of scope.
	if (url.pathname === "/v1/messages") {
		const verdict = recordSessionRequest(requestMeta.clientSessionId);
		if (verdict?.rejected) {
			return buildSessionRejectResponse(verdict);
		}
	}

	const applyUsageThrottling = (accounts: Account[]) => {
		const settings = {
			fiveHourEnabled: ctx.config.getUsageThrottlingFiveHourEnabled(),
			weeklyEnabled: ctx.config.getUsageThrottlingWeeklyEnabled(),
		};
		if (!settings.fiveHourEnabled && !settings.weeklyEnabled) {
			return { available: accounts, throttled: [] as Account[] };
		}

		// Internal synthetic probes (auto-refresh window-reset checks, cache
		// keepalive replays) must never be usage-throttled. They exist
		// specifically to hit the real endpoint and observe state changes
		// (window resets, recovered accounts) — the same reason
		// selectAccountsForRequest already lets them bypass pause/rate-limit
		// checks (see account-selector.ts's isAutoRefreshBypass). Without this
		// exemption, a throttled-but-healthy account's own synthetic probe gets
		// our own 529 back; the auto-refresh scheduler then misreads that as an
		// endpoint failure and counts it toward its consecutive-failure pause
		// threshold (recordRefreshFailure), auto-pausing a healthy account the
		// instant its usage window resets and the scheduler re-probes it.
		const isSyntheticProbe = isInternalProbe(req.headers, ctx);
		if (isSyntheticProbe) {
			return { available: accounts, throttled: [] as Account[] };
		}

		const now = Date.now();
		const available: Account[] = [];
		const throttled: Account[] = [];

		// Model-aware throttling: a per-model weekly cap should only throttle
		// requests for that model. Use the effective (post-intercept) request
		// model; combo-routed requests assign per-slot models later, so skip
		// scoped caps (null) and rely on the flat windows + reactive out_of_credits.
		// combo routing sets meta.comboName during selection and CLEARS it on the
		// step-10 fallback; use it (not the stale comboSlotInfo WeakMap, which the
		// fallback does not clear) so fallback routing still applies per-model scoped
		// throttling for its now-known single model.
		const comboRouted = requestMeta.comboName != null;
		const effectiveModel = appliedModel ?? requestModel ?? null;

		for (const account of accounts) {
			const throttleUntil = getAccountUsageThrottleUntil(
				account.provider ?? "anthropic",
				usageCache.get(account.id),
				settings,
				now,
				{
					requestModel: comboRouted ? null : effectiveModel,
					scopedMode: "match",
				},
			);
			if (throttleUntil && throttleUntil > now) {
				throttled.push(account);
				continue;
			}
			available.push(account);
		}

		if (throttled.length > 0) {
			log.info(
				`Usage-throttled ${throttled.length} account(s): ${throttled.map((account) => account.name).join(", ")}`,
			);
		}

		return { available, throttled };
	};

	// xAI cache-native affinity must be recorded only once a response is
	// actually served, never at selection time — see recordXaiAffinitySuccess.
	// A no-op for any non-xai / non-official-endpoint account, or when the
	// feature is disabled (getXaiConvId returns null and the callee no-ops).
	const recordXaiAffinityIfServed = (account: Account) => {
		if (account.provider === "xai" && isOfficialXaiEndpoint(account)) {
			recordXaiAffinitySuccess(requestMeta, account.id);
		}
	};

	/**
	 * Return a refusal that was decided before any upstream was contacted, and
	 * record it as a request all the same.
	 *
	 * Recording matters: a routing rule that silently drops requests would make
	 * the dashboard show a quiet, healthy proxy while clients get 503s. Shared
	 * by every deliberate refusal so they cannot drift in what they report.
	 */
	const returnRefusal = async (
		refusalResponse: Response,
		errorCode: string,
		failoverAttempts: number,
		comboName: string | null,
	): Promise<Response> => {
		const disabledFallbackResponse = refusalResponse;
		const collector = tryGetUsageCollector();
		if (collector) {
			collector.handleStart({
				type: "start",
				messageId: crypto.randomUUID(),
				requestId: requestMeta.id,
				accountId: null,
				method: req.method,
				path: url.pathname,
				timestamp: requestMeta.timestamp,
				requestHeaders: Object.fromEntries(req.headers.entries()),
				requestBody: null,
				project: project ?? null,
				projectAttributionSource: projectAttributionSource ?? "none",
				agentAttributionSource: agentAttributionSource ?? "none",
				// The refusal's own status, not a hard-coded 503: every other refusal
				// routed through here is a 503, but `vision_unsupported` is a
				// request-level 400, and recording a 503 would put a status in the
				// request log that the client never received.
				responseStatus: refusalResponse.status,
				responseHeaders: Object.fromEntries(
					disabledFallbackResponse.headers.entries(),
				),
				isStream: false,
				providerName: ctx.provider.name,
				accountBillingType: null,
				accountAutoPauseOnOverageEnabled: 0,
				accountName: null,
				agentUsed: agentUsed || null,
				clientSessionId: requestMeta.clientSessionId ?? null,
				originalModel: originalModel || null,
				appliedModel: appliedModel || null,
				comboName,
				apiKeyId: apiKeyId || null,
				apiKeyName: apiKeyName || null,
				retryAttempt: 0,
				failoverAttempts,
			});
			try {
				await collector.handleEnd({
					type: "end",
					requestId: requestMeta.id,
					success: false,
					error: errorCode,
				});
			} catch (err) {
				log.error(
					`handleEnd failed for refused request ${requestMeta.id} (${errorCode})`,
					err,
				);
			}
		}
		cacheBodyStore.discardStaged(requestMeta.id);
		return disabledFallbackResponse;
	};

	const returnComboSessionFallbackDisabled = (
		comboName: string,
		failoverAttempts: number,
	): Promise<Response> =>
		returnRefusal(
			createComboSessionFallbackDisabledResponse(comboName),
			"combo_session_fallback_disabled",
			failoverAttempts,
			comboName,
		);

	// Seam 5, emitted. Decided above on the un-rewritten client model; recorded
	// through returnRefusal so it lands in request history and the dashboard
	// fail-rate rather than silently vanishing.
	//
	// This sits immediately BEFORE account selection, not after: a request the
	// key may not make should cost no routing work at all — no account read, no
	// strategy run, and certainly no upstream contact. It could not be emitted
	// at its decision point further up because `returnRefusal` needs the
	// request metadata and the interceptor's applied/original model to record
	// the request, and those do not exist yet there.
	if (modelRestrictionDenied) {
		log.warn(
			`API key restrictions: refusing model "${requestModel}" — key ${apiKeyName ?? apiKeyId ?? "(unknown)"} is limited to a model allowlist`,
		);
		return await returnRefusal(
			createApiKeyRestrictionResponse(
				"api_key_model_restricted",
				`This API key is not permitted to use the model "${requestModel}".`,
				{ model: requestModel ?? null },
			),
			"api_key_model_restricted",
			0,
			null,
		);
	}

	// Spend limit, emitted. Decided above from the in-memory counter; recorded
	// through returnRefusal so a refused request lands in request history and
	// the dashboard fail-rate rather than silently vanishing.
	//
	// It sits AFTER the model allowlist and BEFORE account selection. After,
	// because a model this key may never use is the more fundamental denial
	// and reporting a budget problem for it would send the caller after the
	// wrong fix; before, because a request that is over budget should cost no
	// routing work at all.
	//
	// `warn` NEVER refuses. It falls through to the alert below and the
	// request proceeds exactly as it would with no limit set.
	if (spendLimitExceeded && spendSnapshot) {
		if (keySpendLimit?.limitEnforce === "block") {
			log.warn(
				`API key spend limit: refusing request — key ${apiKeyName ?? apiKeyId ?? "(unknown)"} has spent ${spendSnapshot.spentUsd.toFixed(4)} of its ${spendSnapshot.limitUsd} limit`,
			);
			return await returnRefusal(
				createApiKeySpendLimitResponse({
					limitUsd: spendSnapshot.limitUsd,
					spentUsd: spendSnapshot.spentUsd,
					window: keySpendLimit.limitWindow,
					resetMs: spendSnapshot.resetMs,
				}),
				"api_key_limit_exceeded",
				0,
				null,
			);
		}
		// warn mode. The overage still has to be VISIBLE, or "warn" means
		// "silently ignore": the dashboard gauge shows it on every key row, and
		// this raises an alert through the existing alerts subsystem. The event
		// bus is the established seam for exactly this (auth-failure-events.ts
		// does the same thing from the refresh scheduler) — the alert service
		// lives in http-api, which depends on this package and not the other
		// way round, so the proxy emits and AlertService listens. No new
		// notification mechanism, and AlertService's own cooldown bucketing
		// stops a busy key from emitting one alert per request.
		log.warn(
			`API key spend limit exceeded (warn only) — key ${apiKeyName ?? apiKeyId ?? "(unknown)"} has spent ${spendSnapshot.spentUsd.toFixed(4)} of its ${spendSnapshot.limitUsd} limit`,
		);
		spendLimitEvents.emit("event", {
			apiKeyId: apiKeyId ?? "",
			apiKeyName: apiKeyName ?? null,
			spentUsd: spendSnapshot.spentUsd,
			limitUsd: spendSnapshot.limitUsd,
			window: keySpendLimit?.limitWindow ?? "rolling_30d",
		} satisfies SpendLimitExceededEvt);
	}

	// 6. Select accounts. Route on the model that will actually be sent
	// upstream (post-interceptor-rewrite), not the model the client asked
	// for — otherwise combo routing and family-based selection see a model
	// that no longer matches the outgoing request.
	const effectiveModel = resolveEffectiveModel(appliedModel, requestModel);
	const selectedAccounts = await selectAccountsForRequest(
		requestMeta,
		ctx,
		effectiveModel ?? undefined,
		{ restrictions: keyRestrictions },
	);

	const { available: accounts, throttled: throttledAccounts } =
		applyUsageThrottling(selectedAccounts);

	// 7. Handle no accounts case
	if (accounts.length === 0) {
		if (requestMeta.comboName && isComboSessionFallbackDisabled(ctx)) {
			return await returnComboSessionFallbackDisabled(requestMeta.comboName, 0);
		}

		// The API key's own account / provider allowlist emptied the pool
		// (recorded by account-selector.ts — seams 1 and 2). This is a policy
		// decision, not capacity, so it gets its own branch and must not fall
		// through to the pool_exhausted 503 below: that answer advertises a
		// Retry-After and invites a retry that can never succeed.
		//
		// It comes FIRST among the distinct branches on purpose. When the pool
		// was emptied by policy, every other diagnosis below is wrong by
		// construction — there was no capacity question to answer.
		const restrictionDenial = getApiKeyRestrictionDenial(requestMeta);
		if (restrictionDenial) {
			const detail =
				restrictionDenial.scope === "forced account"
					? `The account requested via x-better-ccflare-account-id (${restrictionDenial.forcedAccountName ?? "unknown"}) is not permitted for this API key.`
					: `This API key is restricted to specific ${restrictionDenial.scope}, and none of them can serve this request.`;
			log.warn(`API key restrictions: ${detail}`);
			return await returnRefusal(
				createApiKeyRestrictionResponse("api_key_account_restricted", detail, {
					restricted_by: restrictionDenial.scope,
				}),
				"api_key_account_restricted",
				0,
				null,
			);
		}

		// Model-scoped capacity filter (account-selector.ts) emptied the
		// candidate pool because every account is exhausted for this request's
		// model family — a structured, actionable response instead of the
		// generic pool_exhausted 503 or exhausting failover against accounts
		// already known to reject this model family.
		const exhaustionInfo = getModelFamilyExhaustionInfo(requestMeta);
		if (exhaustionInfo) {
			return createModelFamilyExhaustedResponse(exhaustionInfo);
		}

		if (throttledAccounts.length > 0) {
			return createUsageThrottledResponse(throttledAccounts);
		}

		// Nothing can serve the model that was asked for, and substituting one
		// is exactly what this setting forbids. Answering here — rather than
		// letting the generic pool_exhausted 503 answer — is what tells the
		// caller which model went unserved.
		//
		// This comes *after* the exhaustion and throttling branches on purpose.
		// An account that speaks the requested model but is out of quota right
		// now is a temporary, actionable state, and those branches carry the
		// `resetAt`/`Retry-After` that says when to come back. Answering
		// "nothing can serve this model" over them would replace a fact with a
		// falsehood and drop the retry time on the floor. What is left here is
		// the case this setting is actually about: the pool emptied because the
		// compatibility filter removed every candidate.
		if (effectiveModel && isForceAccountModelEnabled(ctx)) {
			return await returnRefusal(
				createForceAccountModelResponse(effectiveModel),
				"force_account_model_no_account",
				0,
				null,
			);
		}

		// Check feature flag for backwards compatibility. Internal probes are
		// exempt: passing one through unauthenticated earns a 401 from upstream,
		// which the auto-refresh scheduler reads as dead credentials for an
		// account this request never carried. A probe always gets the 503.
		if (
			process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL === "1" &&
			!isInternalProbe(req.headers, ctx)
		) {
			log.warn(ERROR_MESSAGES.NO_ACCOUNTS);
			return proxyUnauthenticated(
				req,
				url,
				requestMeta,
				finalBodyBuffer,
				finalCreateBodyStream,
				ctx,
				apiKeyId,
				apiKeyName,
			);
		}

		// Return 503 pool_exhausted response (default behavior)
		log.error(ERROR_MESSAGES.POOL_EXHAUSTED);

		// Log to request history via worker
		// Re-fetch from DB — selectedAccounts is empty here (strategy already
		// filtered out unavailable accounts), so we need fresh data to populate
		// per-account cooldown info in the 503 body.
		const allAccounts = (await ctx.dbOps.getAllAccounts()).filter(
			(a) => a.provider === ctx.provider.name,
		);

		// Build a usage snapshot map (id → snapshot) so createPoolExhaustedResponse
		// can surface `usage_exhausted` reasons and derive next_available_at /
		// Retry-After from the same telemetry the strategy just consulted.
		// Without this, accounts at 100% utilization with no rate_limited_until
		// fall through to the catch-all `unavailable` branch with a default
		// Retry-After of 60s — see incident 2026-07-30T20:24-22:20Z.
		//
		// The snapshot MUST pair utilization with the reset belonging to the SAME
		// window that produced the max — picking them independently (as the
		// pre-fix code did) pairs e.g. Zai's time_limit.max with tokens_limit's
		// reset and lies to clients about when capacity returns (Greptile review
		// on PR #365). The paired helper returns null when no telemetry exists.
		const usageSnapshots = new Map<string, AccountUsageSnapshot>();
		for (const account of allAccounts) {
			const cached = usageCache.get(account.id);
			if (!cached) continue;
			const provider = account.provider ?? "anthropic";
			const snapshot = getRepresentativeUsageSnapshotForProvider(
				cached,
				provider,
			);
			if (snapshot === null) continue;
			usageSnapshots.set(account.id, snapshot);
		}

		const poolExhaustedResponse = createPoolExhaustedResponse(
			allAccounts,
			usageSnapshots,
		);

		// Skip request-log staging for synthetic auto-refresh probes that
		// 503 because their target account is on a known cooldown. Logging
		// these as user-facing 503s inflates the dashboard fail-rate without
		// reflecting any real client impact (issue #199, bug 2). The keepalive
		// scheduler already gets the equivalent treatment via its loop-prevention
		// header path; this brings auto-refresh in line.
		const isAutoRefreshProbe = isInternalProbe(
			req.headers,
			ctx,
			"auto-refresh",
		);
		if (!isAutoRefreshProbe) {
			// Log to request history via usage collector
			getUsageCollector().handleStart({
				type: "start",
				messageId: crypto.randomUUID(),
				requestId: requestMeta.id,
				accountId: null,
				method: req.method,
				path: url.pathname,
				timestamp: requestMeta.timestamp,
				requestHeaders: Object.fromEntries(req.headers.entries()),
				requestBody: null,
				project: project ?? null,
				projectAttributionSource: projectAttributionSource ?? "none",
				agentAttributionSource: agentAttributionSource ?? "none",
				responseStatus: 503,
				responseHeaders: Object.fromEntries(
					poolExhaustedResponse.headers.entries(),
				),
				isStream: false,
				providerName: ctx.provider.name,
				accountBillingType: null,
				accountAutoPauseOnOverageEnabled: 0,
				accountName: null,
				agentUsed: agentUsed || null,
				clientSessionId: requestMeta.clientSessionId ?? null,
				originalModel: originalModel || null,
				appliedModel: appliedModel || null,
				comboName: null,
				apiKeyId: apiKeyId || null,
				apiKeyName: apiKeyName || null,
				retryAttempt: 0,
				failoverAttempts: 0,
			});

			getUsageCollector()
				.handleEnd({
					type: "end",
					requestId: requestMeta.id,
					success: false,
					error: "pool_exhausted",
				})
				.catch((err: unknown) => {
					log.error(
						`handleEnd failed for pool_exhausted request ${requestMeta.id}`,
						err,
					);
				});
		}

		return poolExhaustedResponse;
	}

	// 8. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	// Record the routing decision the proxy just made for the dashboard's
	// "observed routing order" display -- display-only telemetry, never fed
	// back into selection (see routing-observations.ts). Uses the same
	// effectiveModel the capacity filter (selectAccountsForRequest ->
	// getModelFamily) already routed on, so the family attribution can't
	// drift from what actually happened. Not the final word, though: the
	// combo-fallback re-selection below calls recordSelectedOrder again for
	// the same family when it actually runs, and that later call wins
	// (last-write-wins) since it reflects the accounts that really served
	// the request.
	recordSelectedOrder(effectiveModel, accounts, Date.now());
	if (
		process.env.DEBUG?.includes("proxy") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Request: ${req.method} ${url.pathname}`);
	}

	// 9. Try each account
	const comboInfo = getComboSlotInfo(requestMeta);
	const allowedAccountIds = new Set(accounts.map((account) => account.id));
	const filteredComboInfo = comboInfo
		? {
				...comboInfo,
				slots: comboInfo.slots.filter((slot) =>
					allowedAccountIds.has(slot.accountId),
				),
			}
		: null;
	let response: Response | null = null;
	let anyAccountAttempted = false;
	/**
	 * How many candidates this request skipped because their (account, model)
	 * pair is already known to refuse image input.
	 *
	 * Read by `everyEligibleRouteIsBlind` below, which is what makes the terminal
	 * `vision_unsupported` verdict possible at all: a skip is proof that a
	 * candidate is blind WITHOUT an attempt, so a pool where every route was
	 * skipped from the cache — zero upstream calls, zero refusals to count — is
	 * still a pool where nothing can read the image. Counting attempts alone, the
	 * way the reverted first attempt did, sees `0 === 0` there and has nothing to
	 * say. Counted per candidate (not per skip decision: the ungated retries below
	 * decline to re-ask a candidate the loop already counted).
	 */
	let visionSkips = 0;

	/**
	 * Candidates this request actually handed to `proxyWithAccount`, and how many
	 * of those had their upstream refuse the image.
	 *
	 * An attempt that refused is the other way a route becomes *known* blind —
	 * the first-hand way, and the one that writes the cache entry a later request
	 * skips on. An attempt that failed for any other reason proves nothing about
	 * the image, so it must hold the verdict open.
	 */
	let attempted = 0;
	let visionRejections = 0;

	/**
	 * Whether THIS request carries image content — resolved lazily, at most once
	 * per request and shared by every candidate, mirroring the thunk
	 * proxy-operations.ts uses on the response path.
	 *
	 * Walking the parsed body is O(messages x blocks) and a long conversation
	 * makes that non-trivial, so it must never run for a request that has no
	 * chance of being skipped. It only ever runs behind a cache hit — see
	 * `visionSkipModel`.
	 */
	let requestCarriesImagesResolved: boolean | null = null;
	const requestCarriesImages = () =>
		(requestCarriesImagesResolved ??=
			requestCarriesImageContent(requestBodyContext));

	/**
	 * Whether the request's own body carries a `provider` routing object.
	 * Resolved at most once, like {@link requestCarriesImages}: the parsed body
	 * is already standing by then (`visionKeyModelFor` reads the model off it),
	 * so this is one property read.
	 *
	 * The body is UNPATCHED here — slot overrides patch a copy inside
	 * `proxyWithAccount` — so a `provider` on it is the client's, not routing
	 * the selector applied.
	 */
	let clientProviderRoutingResolved: boolean | null = null;
	const clientProviderRouting = () =>
		(clientProviderRoutingResolved ??=
			requestBodyContext.getParsedJson()?.provider != null);

	/**
	 * Whether the vision capability cache may speak for a (account, keyModel)
	 * pair ON THIS REQUEST. It may not when the request carries a client
	 * `provider` the key does not represent: the key is the (account, model)
	 * pair, suffix included, so a key model WITHOUT a routing suffix says
	 * nothing about which upstream the client's `provider` selects — an entry
	 * under it was learned under some other routing (or none) and must neither
	 * skip a candidate nor prove a deferred one blind.
	 *
	 * A key model WITH a suffix is the opposite case: when a slot override
	 * carries one, `resolveSlotRouting` overwrites `body.provider` from it, so
	 * the effective routing IS the suffix already in the key, and the cache
	 * speaks for the pair exactly as it does without a client `provider`.
	 *
	 * The write side suppresses the mark under the same condition (see
	 * `visionRoutingUnrepresentedInKey` in proxy-operations.ts), so learn and
	 * skip stay symmetric: a suffixed slot pin learns and skips normally under
	 * a client `provider`, and a client `provider` with no suffix does neither.
	 */
	const cacheSpeaksForKeyModel = (keyModel: string): boolean =>
		!clientProviderRouting() || splitModelRouting(keyModel).routing != null;

	/**
	 * The model half of the vision capability key for a candidate: its combo
	 * slot's model override when one applied, otherwise the request's own model,
	 * with any provider-routing suffix left intact.
	 *
	 * ONE expression, shared by the skip decision, by the deferred-candidate
	 * check and by the attempted-pair key, because it has to be byte-identical to
	 * the one `proxyWithAccount` records a refusal under (`visionKeyModel` in
	 * proxy-operations.ts). A read that differs from the write by one character is
	 * a different key: the cache never hits, and the verdict silently loses every
	 * piece of evidence the cache was supposed to supply. The suffix stays in the
	 * key because it selects which upstream answers, so the same model id pinned to
	 * two providers is two capability questions.
	 */
	const visionKeyModelFor = (
		slotModelOverride: string | null | undefined,
	): string =>
		(slotModelOverride ? slotModelOverride : requestBodyContext.getModel()) ??
		"";

	/** Identity of an (account, model) capability question, for the sets below. */
	const candidatePairKey = (
		accountId: string,
		slotModelOverride: string | null | undefined,
	): string => `${accountId}\u0000${visionKeyModelFor(slotModelOverride)}`;

	/**
	 * Candidates that were eligible for this request but never reached an attempt,
	 * keyed by {@link candidatePairKey}: probe-gate suppressions in the loops
	 * below, combo slots the selector dropped, and accounts usage throttling held
	 * back. The selector's own drops are recorded separately, on `requestMeta` —
	 * see {@link getDeferredCandidates}, read at verdict time because the Step-10
	 * fallback re-selects and appends to that list.
	 *
	 * Each is a reason the verdict must stay retryable UNLESS the cache already
	 * knows the pair blind, which is checked in `everyEligibleRouteIsBlind`.
	 */
	const deferredCandidates = new Map<
		string,
		{ accountId: string; modelOverride: string | null }
	>();

	/**
	 * Pairs actually handed to `proxyWithAccount`. A deferred pair that was later
	 * attempted is no longer deferred — which is what keeps the ungated retries
	 * honest: they cover exactly one suppressed candidate, so a pool of two
	 * suppressed candidates still has one that was never asked.
	 */
	const attemptedPairs = new Set<string>();

	const noteDeferred = (
		accountId: string,
		modelOverride: string | null,
	): void => {
		deferredCandidates.set(candidatePairKey(accountId, modelOverride), {
			accountId,
			modelOverride,
		});
	};

	const noteAttempted = (
		accountId: string,
		modelOverride: string | null,
	): void => {
		attempted++;
		attemptedPairs.add(candidatePairKey(accountId, modelOverride));
		// proxyWithAccount stamps visionRejected per attempt; read it back after.
		requestMeta.visionRejected = false;
	};

	/**
	 * The key model when this candidate must be skipped as known-blind, or null
	 * when it must be attempted.
	 *
	 * Evaluation order is the point of this function:
	 *
	 *     isVisionUnsupported(...)   one Map lookup — every candidate pays it
	 *       && requestCarriesImages()  the body walk — only a hit pays it
	 *
	 * A cache entry can only exist for a pair that refused an *image* request, so
	 * a hit is already strong evidence this request carries an image: the walk is
	 * a confirmation, not a filter. Text-only traffic — the overwhelming majority
	 * — never reaches it and pays one Map lookup per candidate, nothing else.
	 * The confirmation is still needed because the same (account, model) pair can
	 * serve a text-only request perfectly well, and the image gate (not this
	 * cache) governs whether an image is forwarded at all.
	 */
	const visionSkipModel = (
		candidate: Account,
		slotModelOverride: string | null | undefined,
	): string | null => {
		const keyModel = visionKeyModelFor(slotModelOverride);
		if (!isVisionUnsupported(candidate.id, keyModel)) return null;
		// A client `provider` the key does not represent (see
		// `cacheSpeaksForKeyModel`): still cheaper than the body walk below, and
		// the pair must be asked, not skipped.
		if (!cacheSpeaksForKeyModel(keyModel)) return null;
		return requestCarriesImages() ? keyModel : null;
	};

	/**
	 * Usage throttling — applied here, AFTER selection — is the one deferral the
	 * selector cannot see, so it is recorded here: an account held back for a
	 * usage window is out for minutes, not for good, which is exactly the
	 * time-bound kind of deferral that needs no eligibility filter.
	 *
	 * Keyed by what that account would have been asked for: under combo routing,
	 * its own slot's pin — an account can hold several slots, each pin is its own
	 * capability question, and deferring the request's own model instead would
	 * record a pair that was never on offer. Under pool routing, the request's
	 * own model (null resolves against the body in the verdict).
	 *
	 * The selector's own drops — pool accounts the strategy benched and combo
	 * slots it could not route — are recorded THERE, in account-selector.ts
	 * (`notePoolDeferrals` and the combo-slot recording beside it), where the
	 * account rows already live and the indefinite hold-out filter
	 * (`isIndefinitelyHeldOut`) can be applied without a DB read on this path.
	 * That filter is why the recording moved out of proxy.ts: a combo diff
	 * computed here sees only (accountId, modelOverride), so a manually paused
	 * or dead-token slot was indistinguishable from a cooling one and held the
	 * verdict open forever.
	 */
	if (comboInfo?.definitionSlots) {
		for (const account of throttledAccounts) {
			for (const slot of comboInfo.slots) {
				if (slot.accountId === account.id) {
					noteDeferred(slot.accountId, slot.modelOverride);
				}
			}
		}
	} else {
		for (const account of throttledAccounts) {
			noteDeferred(account.id, null);
		}
	}

	/**
	 * True only when every candidate that was ELIGIBLE for this request is known
	 * unable to serve its image — which is the one state in which "no model can
	 * read this image" is a permanent fact rather than a snapshot of who happened
	 * to be available.
	 *
	 * "Known" is either of:
	 *
	 *   - it was attempted and its upstream refused the image (`visionRejections`);
	 *   - it was never attempted because the capability cache already records it
	 *     blind (`visionSkips`) — the case availability-counting cannot see, and
	 *     the reason this predicate is built on the cache.
	 *
	 * and there is nothing left over. A candidate deferred for a temporary reason —
	 * probe-suppressed in a loop, dropped by the selector for a cooldown, a
	 * rate-limit window, a usage or capacity cap, or held back by usage throttling
	 * — blocks the verdict UNLESS the cache already knows that exact pair blind.
	 * The consequence is the point of the design: a cooling slot that is known
	 * blind no longer holds the verdict open, because knowledge survives cooldowns,
	 * probes and capacity filters and availability does not.
	 *
	 * A refusal the model-cycling fallback suppressed never reaches
	 * `visionRejections` (see `modelCycledTo` in proxy-operations.ts), so an attempt
	 * whose refusal belongs to a fallback alias counts as unknown capability and
	 * keeps the request retryable.
	 *
	 * Expressed as two sums rather than a chain of early returns so that the
	 * partition is the code: the three groups are disjoint by construction, since a
	 * candidate the loop reached was either skipped from the cache, suppressed by
	 * the probe gate, or handed to proxyWithAccount, and a candidate the selector
	 * dropped never reached the loop at all. `visionSkips` cancels out of the
	 * equality but not out of `eligible > 0`, which is exactly the case it exists
	 * for — an all-skipped pool has no attempts and no refusals to compare, so
	 * without those skips counted there is nothing to say the verdict is about.
	 */
	const everyEligibleRouteIsBlind = (): boolean => {
		const isKnownBlind = (deferred: {
			accountId: string;
			modelOverride: string | null;
		}): boolean => {
			const keyModel = visionKeyModelFor(deferred.modelOverride);
			// Same gate as the skip read: an entry the key does not represent
			// cannot prove a deferred pair blind either, or a client `provider`
			// would let a refusal learned under other routing answer a permanent
			// 400 for a pair that was never asked under this routing.
			return (
				cacheSpeaksForKeyModel(keyModel) &&
				isVisionUnsupported(deferred.accountId, keyModel)
			);
		};

		let eligible = attempted + visionSkips;
		let knownBlind = visionRejections + visionSkips;

		// A deferred pair that WAS attempted later in the same request is not
		// deferred at all — that is what each ungated retry does to exactly one
		// suppressed candidate. Skipping it here is what keeps the two sums over a
		// disjoint partition. It is deliberately not left to the cache: a refusal
		// writes the same pair a moment earlier, so the two usually agree, but the
		// first-hand fact is that this request asked, and that must not depend on
		// the entry still being there when the verdict runs (an invalidation or a
		// TTL expiry can land in between).
		const count = (
			deferred: { accountId: string; modelOverride: string | null },
			key: string,
		): void => {
			if (attemptedPairs.has(key)) return;
			eligible++;
			if (isKnownBlind(deferred)) knownBlind++;
		};

		for (const [key, deferred] of deferredCandidates) {
			count(deferred, key);
		}
		// The selector's own drops, read here rather than before the loops: the
		// Step-10 fallback re-selects and appends to that list.
		for (const deferred of getDeferredCandidates(requestMeta)) {
			count(
				deferred,
				candidatePairKey(deferred.accountId, deferred.modelOverride),
			);
		}

		// `eligible > 0` is what stops a request with no evidence at all from
		// satisfying the equality at zero and answering a permanent 400 about an
		// image no upstream was ever asked to read. `knownBlind === eligible`
		// subsumes "every attempt refused": with visionRejections <= attempted and
		// the blind deferrals <= all of them, the equality can only hold when both
		// are tight.
		return eligible > 0 && knownBlind === eligible;
	};

	/** The permanent, non-retryable answer for an image no eligible route can read. */
	const visionRefusal = () =>
		returnRefusal(
			createPoolExhaustedResponse([], undefined, "vision_unsupported"),
			"vision_unsupported",
			// Attempts past the first are failovers; the dashboard reads this to
			// show how far down the combo/pool the request got. Zero when every
			// candidate was skipped from the cache, which is honest — no upstream
			// was contacted at all.
			Math.max(0, attempted - 1),
			requestMeta.comboName ?? null,
		);

	// A terminal CodeBuddy gateway rejection (11128) is the only failover
	// outcome that carries a client-meaningful explanation, so it is kept
	// across later attempts. If every candidate fails, the *last* such
	// rejection is returned to the client instead of the generic
	// "all accounts failed" 503 — otherwise the caller has to read server
	// logs to know why CodeBuddy refused. Sticky rather than last-wins: a
	// later attempt failing for an unrelated reason (429, 5xx) must not
	// erase the explanation.
	let terminalRejection: (() => Promise<Response | null>) | undefined;

	/**
	 * How the combo loop resolves the model override for index `index`: the
	 * slot's pin when the slot exists and its account matches the candidate at
	 * that index, null otherwise — the loop body's own expression, minus its
	 * desync log, factored out so the last-attempt look-ahead below can resolve
	 * a TAIL candidate's key the same way the loop will when it gets there.
	 */
	const slotOverrideFor = (index: number): string | null => {
		const slot = filteredComboInfo?.slots[index];
		return slot && slot.accountId === accounts[index].id
			? slot.modelOverride
			: null;
	};

	for (let i = 0; i < accounts.length; i++) {
		// For combo routing: enrich metadata with slot index and look up model override
		let modelOverride: string | null = null;
		if (filteredComboInfo?.slots[i]) {
			const slot = filteredComboInfo.slots[i];
			if (slot.accountId !== accounts[i].id) {
				log.error(
					`Combo slot/account desync: slot ${i} expects account ${slot.accountId} but got ${accounts[i].id}`,
				);
			} else {
				modelOverride = slot.modelOverride;
			}
			requestMeta.comboSlotIndex = i;
			log.info(
				`Attempting combo slot ${i}/${accounts.length - 1} on account ${accounts[i].name} with model "${modelOverride}"`,
			);
		}

		// Skip a route whose upstream already refused image input for this exact
		// model. Checked BEFORE the probe gate below, for two reasons: it is the
		// cheaper test, and `getRateLimitProbeAdmission` takes the single-flight
		// lease when it admits — a lease taken for a candidate we then skip would
		// hold a recovering account's probe open for a request that was never
		// going to be sent to it.
		const blindModel = visionSkipModel(accounts[i], modelOverride);
		if (blindModel !== null) {
			visionSkips++;
			log.debug(
				`Skipping account ${accounts[i].name} for model "${blindModel}": ` +
					`its upstream already refused image input for this pair, so the round-trip is not spent re-asking`,
			);
			continue;
		}

		const probeAdmission = getRateLimitProbeAdmission(accounts[i]);
		if (probeAdmission === "suppressed") {
			// A mature cooldown just expired for this account and another
			// concurrent request is already probing it. Skip straight to the
			// next account instead of stampeding the recovering account.
			//
			// Record it as deferred: a suppressed account is only *temporarily*
			// unavailable, so unless the cache already knows this pair blind it
			// could read the image the moment the other request's probe finishes,
			// and the terminal verdict below must not claim otherwise.
			noteDeferred(accounts[i].id, modelOverride);
			continue;
		}

		anyAccountAttempted = true;
		noteAttempted(accounts[i].id, modelOverride);
		// The last actually-attempted candidate is not always the last pool
		// index: a probe-suppressed OR vision-skipped tail account gets skipped
		// via `continue` above rather than attempted. Look ahead at the
		// remaining candidates' CURRENT suppression state (without taking a
		// lease) to find out whether any of them would still be attempted after
		// this one. `visionSkipModel` is memoised and side-effect free, so
		// asking it here is safe — and necessary: a cached-blind tail that the
		// probe gate would happily admit used to read as "still to come", so
		// this account looked non-terminal, its persistent 502/529 was
		// discarded for a failover that then skipped the tail, and the client
		// got a generic 503 instead of the upstream's own status.
		const isLastAttemptedCandidate = accounts
			.slice(i + 1)
			.every(
				(candidate, offset) =>
					wouldSuppressProbe(candidate) ||
					visionSkipModel(candidate, slotOverrideFor(i + 1 + offset)) !== null,
			);
		try {
			response = await proxyWithAccount(
				req,
				url,
				accounts[i],
				requestMeta,
				finalBodyBuffer,
				finalCreateBodyStream,
				i,
				ctx,
				modelOverride,
				apiKeyId,
				apiKeyName,
				requestBodyContext,
				!filteredComboInfo?.comboName && isLastAttemptedCandidate,
				(capture: () => Promise<Response | null>) => {
					terminalRejection = capture;
				},
			);
		} finally {
			if (probeAdmission === "admitted") {
				completeRateLimitProbe(accounts[i], "abandoned");
			}
		}

		if (response) {
			recordXaiAffinityIfServed(accounts[i]);
			return response;
		}

		if (requestMeta.visionRejected) visionRejections++;

		// Log combo slot failure
		if (filteredComboInfo) {
			log.info(
				`Combo slot ${i} failed on account ${accounts[i].name}${i < accounts.length - 1 ? ", trying next slot" : ", all combo slots exhausted"}`,
			);
		}
	}

	// Every candidate was single-flight probe-gate suppressed — no account was
	// ever actually attempted. The gate's purpose is to prefer another account
	// over stampeding one that just recovered, not to drop the request when
	// there is no other account to prefer: retry the highest-priority
	// candidate once, bypassing the gate, instead of falling through to a hard
	// 503 against what may be a perfectly healthy account.
	if (!anyAccountAttempted && accounts.length > 0) {
		const i = 0;
		let modelOverride: string | null = null;
		if (filteredComboInfo?.slots[i]?.accountId === accounts[i].id) {
			modelOverride = filteredComboInfo.slots[i].modelOverride;
		}
		// This retry was written for probe suppression, and it keeps that
		// behaviour untouched: a candidate that is merely mid-recovery is still
		// retried ungated. It must not, however, become a second door onto a route
		// the loop just skipped as known-blind — when every candidate was skipped
		// for refusing image input, `anyAccountAttempted` is false too, and
		// re-issuing here would spend exactly the round-trip the skip exists to
		// save. So the same test runs again on the one account this block would
		// use, and a hit falls through to the normal exhaustion path instead.
		// (`visionSkips` is not incremented: the loop already counted this
		// candidate, since it checks vision before the probe gate.)
		const retryBlindModel = visionSkipModel(accounts[i], modelOverride);
		if (retryBlindModel !== null) {
			log.debug(
				`Not retrying account ${accounts[i].name} ungated for model "${retryBlindModel}": ` +
					`it is known to refuse image input (${visionSkips} candidate(s) already skipped), ` +
					`so this request falls through to the exhaustion path instead of re-asking a blind route`,
			);
		} else {
			log.info(
				`All ${accounts.length} candidate account(s) were probe-gate suppressed; retrying account ${accounts[i].name} ungated`,
			);
			// This retry IS the request's terminal attempt by construction — the
			// loop above already exhausted every candidate before falling through
			// here. Unlike the loop's own `i === accounts.length - 1` check (which
			// tracks whether the CURRENT iteration is the last one), `i` is always
			// 0 in this block regardless of pool size, so that comparison would be
			// a constant `false` for any pool with more than one candidate — the
			// flag must instead depend only on whether this is combo routing.
			//
			// Counted like any other attempt, and the pair marked attempted so it
			// stops counting as deferred: this block covers exactly ONE of the
			// suppressed candidates, so a pool of two suppressed candidates still
			// leaves one that was never asked, and the verdict below stays
			// retryable for it.
			noteAttempted(accounts[i].id, modelOverride);
			response = await proxyWithAccount(
				req,
				url,
				accounts[i],
				requestMeta,
				finalBodyBuffer,
				finalCreateBodyStream,
				i,
				ctx,
				modelOverride,
				apiKeyId,
				apiKeyName,
				requestBodyContext,
				!filteredComboInfo?.comboName,
				(capture: () => Promise<Response | null>) => {
					terminalRejection = capture;
				},
			);

			if (response) {
				recordXaiAffinityIfServed(accounts[i]);
				return response;
			}
			if (requestMeta.visionRejected) visionRejections++;
		}
	}

	// 10. Combo fallback: if combo routing was active and all slots failed,
	//     fall back to normal SessionStrategy routing (REQ-14)
	let fallbackAccounts: Account[] | null = null;
	if (filteredComboInfo?.comboName) {
		if (isComboSessionFallbackDisabled(ctx)) {
			log.warn(
				`All combo slots failed for combo "${filteredComboInfo.comboName}", session fallback disabled by the Combo Session Fallback setting (Settings → Advanced)`,
			);
			// When every eligible route is known blind, the image-specific cause
			// outranks the config-level one: this response is a 503 saying "please
			// try again later", which is wrong when no slot can ever read the image
			// and would have the client retry forever. The WARN above still tells
			// the operator which setting kept the pool untried, so nothing is lost
			// by answering the more accurate cause.
			//
			// Note what makes this safe where the reverted first attempt was not:
			// the untried pool is not assumed blind, it is checked. Its candidates
			// are in `deferredCandidates` / `getDeferredCandidates` unless the
			// capability cache already knows them blind, so a pool that might have
			// served the image keeps the retryable config-level answer.
			if (everyEligibleRouteIsBlind()) return await visionRefusal();
			return await returnComboSessionFallbackDisabled(
				filteredComboInfo.comboName,
				accounts.length,
			);
		}

		log.warn(
			`All combo slots failed for combo "${filteredComboInfo.comboName}", falling back to SessionStrategy routing`,
		);
		// Clear combo info and retry with normal routing. Pass the effective
		// model + skipCombo:true so this re-selection (a) applies the same
		// model-scoped capacity filter as the initial selection instead of
		// blindly re-attempting the just-failed combo accounts unfiltered, and
		// (b) does not re-trigger the same combo lookup — the combo lookup is
		// keyed on the model's family, not on requestMeta.comboName, so clearing
		// comboName alone would not make it inert.
		requestMeta.comboName = null;
		requestMeta.comboSlotIndex = null;
		const selectedFallbackAccounts = await selectAccountsForRequest(
			requestMeta,
			ctx,
			effectiveModel ?? undefined,
			// The key's allowlist has to be repeated here: this re-selection is
			// what actually serves the request when a combo falls back, and
			// dropping it would make a combo failure a restriction bypass.
			{ skipCombo: true, restrictions: keyRestrictions },
		);
		const {
			available: filteredFallbackAccounts,
			throttled: throttledFallbackAccounts,
		} = applyUsageThrottling(selectedFallbackAccounts);
		fallbackAccounts = filteredFallbackAccounts;
		// Same usage-throttling deferral as the initial selection. This one is
		// unconditional: the fallback re-selection cleared comboName and passed
		// skipCombo, so it is pool routing and every candidate here would have been
		// asked for the request's own model.
		for (const account of throttledFallbackAccounts) {
			noteDeferred(account.id, null);
		}
		// This re-selection is what actually serves the request when a combo
		// falls back to SessionStrategy routing, so it must overwrite the
		// dashboard's "observed routing order" entry the initial selection
		// recorded above -- otherwise the table would keep showing the failed
		// combo order as the (stale, never-served) last decision for this
		// family. recordSelectedOrder's last-write-wins semantics make this
		// safe to call unconditionally.
		recordSelectedOrder(effectiveModel, fallbackAccounts, Date.now());

		if (fallbackAccounts.length > 0) {
			log.info(
				`Fallback: trying ${fallbackAccounts.length} SessionStrategy accounts`,
			);
			let anyFallbackAttempted = false;
			for (let i = 0; i < fallbackAccounts.length; i++) {
				// Same known-blind skip as the main loop, and ahead of the probe gate
				// for the same two reasons. The fallback path is never combo-routed
				// (comboName was cleared before the re-selection), so there is no slot
				// override and the key model is the request's own — which is a
				// DIFFERENT key from the one a combo slot's pin produced, so a slot
				// skipped above does not skip the same account here. Correct: without
				// the pin a different upstream may answer, and that upstream has not
				// refused anything yet.
				const blindModel = visionSkipModel(fallbackAccounts[i], null);
				if (blindModel !== null) {
					visionSkips++;
					log.debug(
						`Skipping fallback account ${fallbackAccounts[i].name} for model "${blindModel}": ` +
							`its upstream already refused image input for this pair, so the round-trip is not spent re-asking`,
					);
					continue;
				}

				const probeAdmission = getRateLimitProbeAdmission(fallbackAccounts[i]);
				if (probeAdmission === "suppressed") {
					// As in the main loop: temporarily unavailable, so it holds the
					// terminal verdict open unless the cache already knows it blind.
					noteDeferred(fallbackAccounts[i].id, null);
					continue;
				}

				anyFallbackAttempted = true;
				noteAttempted(fallbackAccounts[i].id, null);
				// Same rationale as the main loop above: a probe-suppressed tail
				// candidate is skipped via `continue`, so the last pool index is
				// not necessarily the last one actually attempted — and the same
				// goes for a tail the vision cache will skip. The fallback path is
				// never combo-routed (comboName was cleared before the
				// re-selection), so there is no slot pin to resolve: the key model
				// is the request's own.
				const isLastAttemptedFallback = fallbackAccounts
					.slice(i + 1)
					.every(
						(candidate) =>
							wouldSuppressProbe(candidate) ||
							visionSkipModel(candidate, null) !== null,
					);
				try {
					response = await proxyWithAccount(
						req,
						url,
						fallbackAccounts[i],
						requestMeta,
						finalBodyBuffer,
						finalCreateBodyStream,
						i,
						ctx,
						undefined, // No model override for fallback path
						apiKeyId,
						apiKeyName,
						requestBodyContext,
						isLastAttemptedFallback,
						(capture: () => Promise<Response | null>) => {
							terminalRejection = capture;
						},
					);
				} finally {
					if (probeAdmission === "admitted") {
						completeRateLimitProbe(fallbackAccounts[i], "abandoned");
					}
				}

				if (response) {
					recordXaiAffinityIfServed(fallbackAccounts[i]);
					return response;
				}
				if (requestMeta.visionRejected) visionRejections++;
			}

			// Same rationale as the main account loop above: an entirely
			// suppressed fallback pool must not fall through to a hard failure.
			if (!anyFallbackAttempted && fallbackAccounts.length > 0) {
				const i = 0;
				// And the same guard as the main loop's ungated retry: it exists for
				// probe suppression, not as a second door onto a route the fallback
				// loop just skipped as known-blind.
				const retryBlindModel = visionSkipModel(fallbackAccounts[i], null);
				if (retryBlindModel !== null) {
					log.debug(
						`Not retrying fallback account ${fallbackAccounts[i].name} ungated for model "${retryBlindModel}": ` +
							`it is known to refuse image input (${visionSkips} candidate(s) already skipped), ` +
							`so this request falls through to the exhaustion path instead of re-asking a blind route`,
					);
				} else {
					log.info(
						`All ${fallbackAccounts.length} fallback candidate(s) were probe-gate suppressed; retrying account ${fallbackAccounts[i].name} ungated`,
					);
					// Same rationale as the main-loop block above: this retry is the
					// terminal attempt by construction (the fallback loop already
					// exhausted every candidate), and the fallback path is never
					// combo-routed (comboName was cleared before re-selection), so the
					// flag is unconditionally true here.
					//
					// Counted, and its pair marked attempted so it stops counting as
					// deferred — as in the main loop's ungated retry, this covers one
					// suppressed candidate and no more.
					noteAttempted(fallbackAccounts[i].id, null);
					response = await proxyWithAccount(
						req,
						url,
						fallbackAccounts[i],
						requestMeta,
						finalBodyBuffer,
						finalCreateBodyStream,
						i,
						ctx,
						undefined,
						apiKeyId,
						apiKeyName,
						requestBodyContext,
						true,
						(capture: () => Promise<Response | null>) => {
							terminalRejection = capture;
						},
					);

					if (response) {
						recordXaiAffinityIfServed(fallbackAccounts[i]);
						return response;
					}
					if (requestMeta.visionRejected) visionRejections++;
				}
			}
		} else {
			// Same no-accounts resolver order as the initial selection (Step 7):
			// capacity-exhaustion first (structured, actionable response instead
			// of falling through to a generic failure), then usage-throttling.
			const fallbackExhaustionInfo = getModelFamilyExhaustionInfo(requestMeta);
			if (fallbackExhaustionInfo) {
				cacheBodyStore.discardStaged(requestMeta.id);
				return createModelFamilyExhaustedResponse(fallbackExhaustionInfo);
			}
			if (throttledFallbackAccounts.length > 0) {
				cacheBodyStore.discardStaged(requestMeta.id);
				return createUsageThrottledResponse(throttledFallbackAccounts);
			}
		}
	}

	// 11. All accounts failed - check if OAuth token issues are the cause
	const allAttemptedAccounts = filteredComboInfo
		? [...accounts, ...(fallbackAccounts ?? [])]
		: accounts;
	const oauthAccounts = allAttemptedAccounts.filter((acc) => acc.refresh_token);
	const needsReauth = oauthAccounts.filter((acc) =>
		isRefreshTokenLikelyExpired(acc),
	);

	// Every candidate eligible for this request is known unable to serve its
	// image: each was either attempted and refused, or is recorded in the
	// capability cache as blind, and nothing was deferred for a temporary reason
	// with its capability still unknown. No account is benched and nothing is
	// cooling down, so answering as an exhausted pool ("503, come back later")
	// would be wrong twice over — the same image fails the same way forever, and
	// nothing here is actually exhausted.
	//
	// Placed before the needsReauth throw and terminalRejection: both would
	// otherwise claim the request with a less accurate cause. An account needing
	// re-authentication cannot rescue an image no route can read, and a sticky
	// gateway rejection is an explanation of one attempt, not of the image.
	// `everyEligibleRouteIsBlind` already keeps a reauth-needing account it never
	// asked holding the verdict open, so this cannot pre-empt a reauth message
	// that would actually have been the actionable one.
	if (everyEligibleRouteIsBlind()) return await visionRefusal();

	if (needsReauth.length > 0) {
		// Quote account names to prevent command injection (defense-in-depth)
		const reauthCommands = needsReauth
			.map(
				(acc) =>
					`bun run cli --reauthenticate "${acc.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
			)
			.join("\n  ");
		cacheBodyStore.discardStaged(requestMeta.id);
		throw new ServiceUnavailableError(
			`All accounts failed to proxy the request. OAuth tokens have expired for accounts: ${needsReauth.map((acc) => acc.name).join(", ")}.\n\nPlease re-authenticate:\n  ${reauthCommands}`,
			ctx.provider.name,
		);
	}

	if (terminalRejection !== undefined) {
		// The replay bypasses forwardToClient, the path that normally lets
		// usage-collector's onSummary delete this request's staged body. Drop it
		// here, or repeated all-candidates-rejected failures would sit in the
		// 64 MiB staging allowance and evict bodies of active requests.
		cacheBodyStore.discardStaged(requestMeta.id);
		const rejectionResponse = await terminalRejection();
		if (rejectionResponse) return rejectionResponse;
	}

	cacheBodyStore.discardStaged(requestMeta.id);
	throw new ServiceUnavailableError(
		`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${allAttemptedAccounts.length} attempted)`,
		ctx.provider.name,
	);
}

/**
 * Injects `ttl: "1h"` into system-level cache_control blocks that are missing a TTL.
 * ArrayBuffer overload: returns modified buffer or null (no changes).
 * RequestBodyContext overload: mutates in-place via markDirty(); return value unused.
 */
export function injectSystemCacheTtl(buf: ArrayBuffer): ArrayBuffer | null;
export function injectSystemCacheTtl(context: RequestBodyContext): void;
export function injectSystemCacheTtl(
	input: ArrayBuffer | RequestBodyContext,
): ArrayBuffer | null {
	const bodyContext =
		input instanceof RequestBodyContext ? input : new RequestBodyContext(input);
	try {
		const body = bodyContext.getParsedJson() as
			| (RequestJsonBody & {
					system?: Array<{ cache_control?: { type?: string; ttl?: string } }>;
			  })
			| null;
		if (!body) return null;
		if (!Array.isArray(body.system)) return null;
		const blocksToUpdate = body.system.filter(
			(block) =>
				block.cache_control?.type === "ephemeral" && !block.cache_control.ttl,
		);
		if (blocksToUpdate.length === 0) return null;
		bodyContext.mutateParsedJson((b) => {
			const typedBody = b as RequestJsonBody & {
				system: Array<{ cache_control?: { type?: string; ttl?: string } }>;
			};
			for (const block of typedBody.system) {
				if (
					block.cache_control?.type === "ephemeral" &&
					!block.cache_control.ttl
				) {
					block.cache_control.ttl = "1h";
				}
			}
		});
		return bodyContext.getBuffer();
	} catch {
		return null;
	}
}
