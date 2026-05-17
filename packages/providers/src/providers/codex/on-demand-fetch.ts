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
 * input with `reasoning.effort = "minimal"` and `max_output_tokens = 1`),
 * and the response body is cancelled as soon as headers are available so we
 * pay at most a handful of input/reasoning tokens per click.
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

	const body = JSON.stringify({
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
		max_output_tokens: 1,
	});

	let upstream: Response;
	try {
		upstream = await fetch(endpoint, {
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
			body,
		});
	} finally {
		clearTimeout(timeoutId);
	}

	const headersSnapshot = new Headers(upstream.headers);
	const status = upstream.status;
	const statusText = upstream.statusText;

	// Parse usage from the snapshot before touching the body so we never race
	// the cancellation. parseCodexUsageHeaders returns null when no Codex
	// usage headers are present; we treat that as a non-fatal failure upstream.
	const data = parseCodexUsageHeaders(headersSnapshot);

	// Drain/cancel the body. We rely on the server honoring stream cancellation
	// to avoid generating further tokens; `max_output_tokens: 1` is the hard cap.
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
}
