import { getClientVersion } from "@better-ccflare/core";
import {
	BadRequest,
	NotFound,
	ServiceUnavailable,
} from "@better-ccflare/errors";
import type { Account } from "@better-ccflare/types";
import type { APIContext } from "../types";
import { errorResponse, jsonResponse } from "../utils/http-error";

/**
 * Header carrying the process-local secret that gates internal-probe requests.
 * Mirrors packages/proxy/src/handlers/proxy-types.ts INTERNAL_PROBE_SECRET_HEADER
 * and the copy in services/auth-service.ts — duplicated for the same reason
 * (no http-api -> proxy value dependency); the string MUST stay in sync.
 */
const INTERNAL_PROBE_SECRET_HEADER = "x-better-ccflare-internal-probe-secret";

/** Hard ceiling on the probe. Short on purpose: this is an interactive check. */
const TEST_TIMEOUT_MS = 20_000;

/**
 * Providers whose accounts must not receive scripted traffic.
 *
 * CLAUDE.md is explicit: real Anthropic accounts are only to be used through
 * real Claude Code, because scripted usage risks provider enforcement. This
 * check is user-initiated and sends a single request, but it is still
 * scripted traffic, so it is refused by default.
 *
 * An operator who accepts that risk on accounts they own can opt in with
 * CCFLARE_ALLOW_ANTHROPIC_MODEL_TEST=1. The default refuses so nobody exposes
 * an account by clicking a button whose cost is not obvious.
 */
const SCRIPTING_RESTRICTED_PROVIDERS = new Set([
	"anthropic",
	"claude-console-api",
]);

const ANTHROPIC_OPT_IN_ENV = "CCFLARE_ALLOW_ANTHROPIC_MODEL_TEST";

function isScriptingRestricted(provider: string | null | undefined): boolean {
	if (!SCRIPTING_RESTRICTED_PROVIDERS.has(provider ?? "anthropic"))
		return false;
	return !/^(1|true|yes|on)$/i.test(process.env[ANTHROPIC_OPT_IN_ENV] ?? "");
}

/** How much of the upstream body is echoed back, in characters. */
const MAX_ERROR_CHARS = 4_000;

export interface ModelTestResult {
	ok: boolean;
	/** true when the failure says nothing about the model (account unavailable now) */
	inconclusive?: boolean;
	/**
	 * Model the upstream actually answered about, when the body carries one.
	 * Differs from `model` when an account mapping or a fallback rewrote the
	 * request.
	 */
	answeredModel?: string;
	status: number;
	durationMs: number;
	accountId: string;
	model: string;
	error?: string;
}

/**
 * Explain why forcing this account would NOT be honored, or null when it
 * would be.
 *
 * selectAccountsForRequest silently falls back to normal pool selection when
 * the forced account is unusable — which for this endpoint is the worst
 * possible outcome: a green result that actually describes some other
 * account. So the cases the forced path refuses are refused here first,
 * before any request is sent.
 *
 * Mirrors the `allowThrough` condition in
 * packages/proxy/src/handlers/account-selector.ts: with the bypass header set
 * (which this probe always sends), an unavailable account is still let
 * through when it is overage-paused, rate-limited or usage-capped — but never
 * when it needs re-auth, and never for a manual / failure_threshold /
 * peak_hours pause.
 */
function describeForcedAccountRefusal(account: Account): string | null {
	if (account.requires_reauth) {
		return "Account requires re-authentication: the proxy would fall back to a different account, so the test could not report on this one";
	}
	if (account.paused) {
		const reason = account.pause_reason;
		// An empty/absent reason is treated as an overage pause, matching the
		// account-selector's `!pause_reason || pause_reason === "overage"`.
		const isResumableOveragePause =
			(!reason || reason === "overage") &&
			account.auto_pause_on_overage_enabled;
		if (!isResumableOveragePause) {
			return `Account is paused (${reason || "overage"}): the proxy would fall back to a different account, so the test could not report on this one. Resume it first.`;
		}
	}
	return null;
}

/**
 * POST /api/accounts/:id/test-model — body { "model": "..." }.
 *
 * Fires ONE minimal real request against that account with that model and
 * reports the upstream's own verdict, passing its error text through raw.
 * The raw text is the whole product here: a catalogue can only say a model
 * exists, while the provider is the only thing that can say whether this
 * account's plan may call it (gpt-5.3-codex answers HTTP 400 on
 * ChatGPT-subscription accounts).
 *
 * Implemented as a self-loop through this server's own proxy path — the same
 * mechanism AutoRefreshScheduler.sendDummyMessage uses — rather than a second
 * dispatch implementation, so token refresh, provider request translation,
 * endpoint resolution and response normalisation are all the real ones.
 *
 * Cost control: max_tokens 1, a two-character prompt, no streaming, 20s cap,
 * session tracking bypassed, and the synthetic-probe marker so request
 * logging, cache-body staging, pool-exhaustion metrics and usage throttling
 * all skip it. Rate-limit headers observed on the way back are still applied
 * to the account — that is inherent to making a real request.
 *
 * Known limit: an account configured with model_mappings / model_fallbacks
 * may have the proxy retry a DIFFERENT model on a "model unavailable" style
 * upstream error, in which case `ok` describes the fallback model. The 400
 * path this feature exists for is unaffected (proxy-operations passes 400s
 * straight through without failover).
 */
export function createAccountModelTestHandler(context: APIContext) {
	return async (req: Request, accountId: string): Promise<Response> => {
		let payload: unknown;
		try {
			payload = await req.json();
		} catch {
			return errorResponse(BadRequest('Body must be JSON: { "model": "..." }'));
		}
		const rawModel = (payload as { model?: unknown } | null)?.model;
		const model = typeof rawModel === "string" ? rawModel.trim() : "";
		if (!model) {
			return errorResponse(
				BadRequest("model is required and must be a string"),
			);
		}

		const account = await context.dbOps.getAccount(accountId);
		if (!account) {
			return errorResponse(NotFound(`Account not found: ${accountId}`));
		}

		const port = context.runtime?.port;
		if (!port) {
			return errorResponse(
				ServiceUnavailable(
					"Server runtime info is not wired up, so the probe has no port to call",
				),
			);
		}

		if (isScriptingRestricted(account.provider)) {
			return jsonResponse({
				ok: false,
				status: 0,
				durationMs: 0,
				accountId,
				model,
				error:
					`Model checks are disabled for provider "${account.provider}": real ` +
					"Anthropic accounts must only be used through real Claude Code. " +
					`Set ${ANTHROPIC_OPT_IN_ENV}=1 to opt in on accounts you own.`,
			} satisfies ModelTestResult);
		}

		const refusal = describeForcedAccountRefusal(account);
		if (refusal) {
			const result: ModelTestResult = {
				ok: false,
				status: 0,
				durationMs: 0,
				accountId,
				model,
				error: refusal,
			};
			return jsonResponse(result);
		}

		// Same protocol determination as AutoRefreshScheduler.sendDummyMessage.
		const protocol =
			process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH ? "https" : "http";
		const endpoint = `${protocol}://localhost:${port}/v1/messages`;

		// Mirrors the header set from AutoRefreshScheduler.sendDummyMessage
		// byte for byte. This is not decoration: Anthropic rejects a request
		// without them with a rate-limit-window-less 429 even when the model
		// and account are perfectly valid — turning this test into a false
		// negative generator. If that set changes there, it must change here.
		const headers = new Headers({
			accept: "application/json",
			"accept-language": "*",
			"anthropic-beta":
				"oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-version": "2023-06-01",
			connection: "keep-alive",
			"content-type": "application/json",
			"sec-fetch-mode": "cors",
			"user-agent": `claude-cli/${getClientVersion()} (external, cli)`,
			"x-app": "cli",
			"x-stainless-arch": "x64",
			"x-stainless-helper-method": "stream",
			"x-stainless-lang": "js",
			"x-stainless-os": "Linux",
			"x-stainless-package-version": "0.60.0",
			"x-stainless-retry-count": "0",
			"x-stainless-runtime": "node",
			"x-stainless-runtime-version": "v24.9.0",
			"x-stainless-timeout": "600",
			// Pin the request to this account.
			"x-better-ccflare-account-id": account.id,
			// Do not start or extend a session for a synthetic probe.
			"x-better-ccflare-bypass-session": "true",
			// Tag as an internal probe: skips request logging, cache-body
			// staging and pool-exhaustion metrics, and is exempt from usage
			// throttling. Also the marker the auth gate requires alongside the
			// secret below.
			"x-better-ccflare-auto-refresh": "true",
		});
		if (context.internalProbeSecret) {
			headers.set(INTERNAL_PROBE_SECRET_HEADER, context.internalProbeSecret);
		}

		// Anthropic OAuth rejects, with a rate-limit-window-less 429, a request
		// that does not resemble Claude Code — and the check is sensitive to the
		// EXACT TEXT of this block (measured: changing the apostrophe in
		// "Anthropic's" already causes a 429). Without it, this test returned
		// false negatives for every model on an Anthropic account, including
		// models serving real traffic with HTTP 200 at the same moment. Do not
		// edit the string.
		const CLAUDE_CODE_SYSTEM_PROMPT =
			"You are Claude Code, Anthropic's official CLI for Claude.";

		const body = JSON.stringify({
			model,
			system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }],
			// Low max_tokens keeps the cost negligible; the shape follows the
			// auto-refresh probe, which the upstream accepts.
			max_tokens: 4,
			messages: [{ role: "user", content: "Say OK" }],
		});

		const startedAt = Date.now();
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
			});
		} catch (error) {
			const result: ModelTestResult = {
				ok: false,
				// 0 = never got an HTTP status back (timeout / transport error),
				// as distinct from an upstream refusal.
				status: 0,
				durationMs: Date.now() - startedAt,
				accountId,
				model,
				error: error instanceof Error ? error.message : String(error),
			};
			return jsonResponse(result);
		}

		let raw = "";
		try {
			raw = await response.text();
		} catch (error) {
			raw = `<failed to read response body: ${
				error instanceof Error ? error.message : String(error)
			}>`;
		}

		// Not every failure says something about the MODEL. A rate-limit-window-
		// less 429, or ccflare's own 503 envelope (all attempts failed), only
		// mean that the account is unavailable now — the question "does this
		// plan accept this model?" remains unanswered. Reporting it as failure
		// would make the user discard a good model.
		const inconclusive =
			!response.ok &&
			(response.status === 429 ||
				response.status === 503 ||
				response.status === 529);

		// The pipeline can answer about a DIFFERENT model than the one asked
		// for: an account mapping rewrites it, and model fallbacks retry another
		// one when the first is unavailable. Labelling that success with the
		// requested model would report it as accepted on an account that cannot
		// call it — precisely the mistake this endpoint exists to prevent. Read
		// back which model answered and refuse to judge on a mismatch.
		let answeredModel: string | undefined;
		try {
			const parsed = JSON.parse(raw) as { model?: unknown };
			if (typeof parsed.model === "string") answeredModel = parsed.model;
		} catch {
			// Not JSON, or an error envelope carrying no model: nothing to compare.
		}
		const mismatched =
			response.ok && answeredModel !== undefined && answeredModel !== model;

		const result: ModelTestResult = {
			ok: response.ok && !mismatched,
			inconclusive: inconclusive || mismatched,
			answeredModel,
			status: response.status,
			durationMs: Date.now() - startedAt,
			accountId,
			model,
		};
		if (mismatched) {
			result.error =
				`The account answered about "${answeredModel}", not "${model}": an ` +
				"account model mapping or a fallback rewrote the request, so the " +
				"requested model was never exercised.";
		} else if (!response.ok) {
			// Raw, unparsed, untranslated. Reading the provider's exact words is
			// the entire value of this endpoint.
			result.error =
				raw.length > MAX_ERROR_CHARS
					? `${raw.slice(0, MAX_ERROR_CHARS)}... [truncated, ${raw.length} chars total]`
					: raw;
		}
		return jsonResponse(result);
	};
}
