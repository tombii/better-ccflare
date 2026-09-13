import { Logger } from "@better-ccflare/logger";
import type { UsageData, UsageWindow } from "../../usage-fetcher";
import { CODEX_USER_AGENT } from "./provider";

const log = new Logger("CodexUsageEndpoint");

/**
 * ChatGPT backend usage endpoint — the one the Codex CLI and Codex Desktop
 * poll for their rate-limit display (`codex-rs/backend-client`,
 * `rate_limit_status_url()` → `{base}/wham/usage`). Unofficial, like
 * Anthropic's `/api/oauth/usage`, but free: a plain GET that consumes no
 * quota, unlike the `/responses` probe in `on-demand-fetch.ts`.
 */
export const CODEX_USAGE_ENDPOINT =
	"https://chatgpt.com/backend-api/wham/usage";

/** Same budget as the other usage fetchers in this package. */
const CODEX_USAGE_REQUEST_TIMEOUT_MS = 5000;

const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * `RateLimitWindowSnapshot` in `codex-backend-openapi-models`. All times are
 * epoch SECONDS (not milliseconds).
 */
export interface CodexUsageWindowPayload {
	used_percent?: number | null;
	limit_window_seconds?: number | null;
	reset_after_seconds?: number | null;
	reset_at?: number | null;
}

/** `RateLimitStatusPayload` — only the fields this module reads. */
export interface CodexUsagePayload {
	plan_type?: string | null;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: CodexUsageWindowPayload | null;
		secondary_window?: CodexUsageWindowPayload | null;
	} | null;
}

export interface CodexUsageFetchResult {
	/** Mapped windows, or null when the response carried none we recognise. */
	data: UsageData | null;
	/** Set on 429 when the response carried a usable Retry-After. */
	retryAfterMs: number | null;
	/** Upstream HTTP status; 0 when the request never completed. */
	status: number;
	/** `plan_type` from the payload (e.g. "plus", "pro"), for logs. */
	planType: string | null;
}

export interface FetchCodexUsageOptions {
	/** Value for the `ChatGPT-Account-Id` header; see `extractChatgptAccountId`. */
	chatgptAccountId?: string | null;
	endpoint?: string;
	timeoutMs?: number;
	/** Injectable clock for tests. */
	now?: () => number;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** ISO string for an epoch-ms value, or null when it is outside the Date-valid range. */
function toIsoString(timestampMs: number): string | null {
	if (!Number.isFinite(timestampMs)) return null;
	const date = new Date(timestampMs);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Mirrors `pickWindowSlot` in `./usage.ts` (which works in minutes off parsed
 * headers): any window up to five hours is the session window, anything from
 * a week up is the weekly window, in-between lengths are not ours to display.
 * Kept identical to the header parser on purpose — the endpoint path and the
 * `x-codex-*` header path must never disagree about how the same account's
 * windows slot.
 */
function slotFor(
	windowSeconds: number | null | undefined,
): "five_hour" | "seven_day" | null {
	if (!isFiniteNumber(windowSeconds) || windowSeconds <= 0) return null;
	if (windowSeconds <= FIVE_HOUR_WINDOW_SECONDS) return "five_hour";
	if (windowSeconds >= SEVEN_DAY_WINDOW_SECONDS) return "seven_day";
	return null;
}

function toWindow(
	raw: CodexUsageWindowPayload,
	nowMs: number,
): UsageWindow | null {
	// Never mint a percentage: a window without used_percent is unknown.
	if (!isFiniteNumber(raw.used_percent)) return null;
	const utilization = Math.min(100, Math.max(0, raw.used_percent));

	let resetsAt: string | null = null;
	if (isFiniteNumber(raw.reset_at) && raw.reset_at > 0) {
		resetsAt = toIsoString(raw.reset_at * 1000);
	}
	if (
		resetsAt === null &&
		isFiniteNumber(raw.reset_after_seconds) &&
		raw.reset_after_seconds >= 0
	) {
		resetsAt = toIsoString(nowMs + raw.reset_after_seconds * 1000);
	}

	return { utilization, resets_at: resetsAt };
}

/**
 * Map a `wham/usage` body into the `UsageData` shape the rest of the system
 * already understands for Codex (`parseCodexUsageHeaders` produces the same).
 * Only the windows actually present come back; an absent window is omitted.
 */
export function parseCodexUsagePayload(
	body: unknown,
	nowMs: number = Date.now(),
): UsageData | null {
	if (typeof body !== "object" || body === null) return null;
	const rateLimit = (body as CodexUsagePayload).rate_limit;
	if (typeof rateLimit !== "object" || rateLimit === null) return null;

	const usage: Pick<UsageData, "five_hour" | "seven_day"> = {};
	for (const raw of [rateLimit.primary_window, rateLimit.secondary_window]) {
		if (typeof raw !== "object" || raw === null) continue;
		const slot = slotFor(raw.limit_window_seconds);
		if (slot === null || usage[slot]) continue;
		const window = toWindow(raw, nowMs);
		if (window) usage[slot] = window;
	}

	return usage.five_hour || usage.seven_day ? usage : null;
}

export function readCodexPlanType(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const planType = (body as CodexUsagePayload).plan_type;
	return typeof planType === "string" && planType !== "" ? planType : null;
}

function parseRetryAfterMs(
	header: string | null,
	nowMs: number,
): number | null {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds > 0)
		return Math.round(seconds * 1000);
	const dateMs = new Date(header).getTime();
	if (Number.isFinite(dateMs) && dateMs > nowMs) return dateMs - nowMs;
	return null;
}

/**
 * Fetch the account's rate-limit windows from the ChatGPT backend. Costs no
 * quota. Non-2xx and transport failures come back as `data: null` with the
 * status so the caller can decide how to back off; 429 additionally carries
 * `retryAfterMs`.
 */
export async function fetchCodexUsageData(
	accessToken: string,
	options: FetchCodexUsageOptions = {},
): Promise<CodexUsageFetchResult> {
	const endpoint = options.endpoint ?? CODEX_USAGE_ENDPOINT;
	const now = options.now ?? Date.now;
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? CODEX_USAGE_REQUEST_TIMEOUT_MS,
	);

	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken.trim()}`,
		Accept: "application/json",
		"User-Agent": CODEX_USER_AGENT,
		originator: "codex_cli_rs",
	};
	if (options.chatgptAccountId) {
		headers["ChatGPT-Account-Id"] = options.chatgptAccountId;
	}

	try {
		const response = await fetch(endpoint, {
			method: "GET",
			headers,
			signal: controller.signal,
		});

		if (!response.ok) {
			const retryAfterMs =
				response.status === 429
					? parseRetryAfterMs(response.headers.get("retry-after"), now())
					: null;
			const bodyText = await response.text().catch(() => "");
			log.warn(
				`Codex usage endpoint returned ${response.status} ${response.statusText}${
					bodyText ? `: ${bodyText.slice(0, 200)}` : ""
				}`,
			);
			return {
				data: null,
				retryAfterMs,
				status: response.status,
				planType: null,
			};
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			log.warn(
				`Codex usage endpoint returned a non-JSON body: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return {
				data: null,
				retryAfterMs: null,
				status: response.status,
				planType: null,
			};
		}

		const data = parseCodexUsagePayload(body, now());
		if (!data) {
			log.warn(
				"Codex usage endpoint returned no recognisable rate_limit windows",
			);
		}
		return {
			data,
			retryAfterMs: null,
			status: response.status,
			planType: readCodexPlanType(body),
		};
	} catch (error) {
		log.warn(
			`Codex usage endpoint request failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { data: null, retryAfterMs: null, status: 0, planType: null };
	} finally {
		clearTimeout(timeoutId);
	}
}
