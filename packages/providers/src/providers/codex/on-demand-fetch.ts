import { validateEndpointUrl } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { UsageData } from "../../usage-fetcher";
import {
	CODEX_DEFAULT_ENDPOINT,
	CODEX_PING_MODEL,
	CODEX_USER_AGENT,
	CODEX_VERSION,
} from "./provider";
import { parseCodexUsageHeaders } from "./usage";

const log = new Logger("CodexOnDemandFetch");

const REQUEST_TIMEOUT_MS = 10_000;

function resolveCodexUsageEndpoint(endpoint: string): string {
	try {
		return validateEndpointUrl(endpoint, "custom_endpoint");
	} catch (error) {
		log.warn(
			`Invalid Codex usage endpoint: ${endpoint}. Using default.`,
			error,
		);
		return CODEX_DEFAULT_ENDPOINT;
	}
}

function isCodexSubscriptionEndpoint(endpoint: string): boolean {
	try {
		const candidate = new URL(endpoint);
		const subscription = new URL(CODEX_DEFAULT_ENDPOINT);
		const normalizePath = (pathname: string) =>
			pathname.replace(/\/+$/, "") || "/";

		return (
			candidate.username === "" &&
			candidate.password === "" &&
			candidate.origin === subscription.origin &&
			normalizePath(candidate.pathname) === normalizePath(subscription.pathname)
		);
	} catch {
		return false;
	}
}

export interface CodexUsageRefreshFetchResult {
	/** Parsed usage windows, or null when no usage headers were returned. */
	data: UsageData | null;
	/**
	 * A synthetic response carrying only the upstream status and headers.
	 * The original body is cancelled to minimise quota consumption, so this
	 * object is safe to pass to header-only consumers like `parseRateLimit`.
	 */
	response: Response;
}

/**
 * Send a minimal Codex `/responses` request whose only purpose is to elicit
 * the `x-codex-*` rate-limit/usage headers that the upstream attaches to
 * every response. The request body is intentionally tiny (a single character
 * input with `reasoning.effort = "minimal"`), and the response is aborted and
 * its body cancelled as soon as headers are captured. The subscription API
 * rejects `max_output_tokens`; custom API-compatible endpoints retain the
 * legacy one-token cap.
 *
 * Unlike Anthropic's `/api/oauth/usage`, OpenAI does not expose a free
 * usage-introspection endpoint, so this call always consumes a small slice
 * of the user's Codex quota.
 */
export async function fetchCodexUsageOnDemand(
	accessToken: string,
	endpoint: string = CODEX_DEFAULT_ENDPOINT,
): Promise<CodexUsageRefreshFetchResult> {
	if (!accessToken || accessToken.trim() === "") {
		throw new Error(
			"fetchCodexUsageOnDemand requires a non-empty access token",
		);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const resolvedEndpoint = resolveCodexUsageEndpoint(endpoint);

	const requestBody: Record<string, unknown> = {
		model: CODEX_PING_MODEL,
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: "." }],
			},
		],
		stream: true,
		store: false,
		reasoning: { effort: "minimal" },
		instructions: "ping",
	};
	if (!isCodexSubscriptionEndpoint(resolvedEndpoint)) {
		requestBody.max_output_tokens = 1;
	}

	try {
		const upstream = await fetch(resolvedEndpoint, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Version: CODEX_VERSION,
				"Openai-Beta": "responses=experimental",
				"User-Agent": CODEX_USER_AGENT,
				originator: "codex_cli_rs",
				Accept: "text/event-stream",
			},
			body: JSON.stringify(requestBody),
		});

		const headersSnapshot = new Headers(upstream.headers);
		const status = upstream.status;
		const statusText = upstream.statusText;

		// Snapshot usage before aborting so cleanup cannot erase quota state that
		// callers need to persist.
		const data = parseCodexUsageHeaders(headersSnapshot);
		controller.abort();

		try {
			await upstream.body?.cancel();
		} catch (error) {
			log.debug("Codex on-demand response body cancel threw:", error);
		}

		const response = new Response(null, {
			status,
			statusText,
			headers: headersSnapshot,
		});

		return { data, response };
	} finally {
		clearTimeout(timeoutId);
	}
}
