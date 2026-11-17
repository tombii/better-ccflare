import { Logger } from "@better-ccflare/logger";
import type { UsageWindowData } from "@better-ccflare/types";

const log = new Logger("OpencodeGoUsageFetcher");

/**
 * OpenCode Go subscription usage endpoint.
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <API key>
 *
 * The response carries three windows, all percentages of Go's shared limit
 * pool (5-hour = 20% of the monthly allowance, weekly = 50%, monthly = 100%):
 *
 *   { "usage": { "rolling": {...}, "weekly": {...}, "monthly": {...} } }
 *
 * each `{ status, percent, resetsAt }`. `status` is "ok" today but may carry a
 * limited state, so it is not interpreted — only `percent` and `resetsAt` are.
 * The endpoint is a metadata GET and costs no quota.
 */
export const OPENCODE_GO_USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";

/**
 * Deadline covering both the response headers and the body read. Mirrors the
 * other usage fetchers: without it a stalled upstream holds the in-flight
 * polling slot for that account open indefinitely.
 */
const OPENCODE_GO_USAGE_REQUEST_TIMEOUT_MS = 5000;

export interface OpencodeGoUsageData {
	/** 5-hour rolling window. */
	five_hour: UsageWindowData | null;
	/** Weekly window. */
	seven_day: UsageWindowData | null;
	/** Billing-period (monthly) window. */
	monthly: UsageWindowData | null;
}

export type OpencodeGoWindowName = "five_hour" | "seven_day" | "monthly";

const WINDOW_KEYS: ReadonlyArray<[OpencodeGoWindowName, string]> = [
	["five_hour", "rolling"],
	["seven_day", "weekly"],
	["monthly", "monthly"],
];

/**
 * `resetsAt` arrives as an ISO 8601 string; accept epoch ms too, defensively.
 * Any other or unparsable value becomes null rather than failing the window —
 * a missing reset only weakens the staleness guard, it does not lose usage.
 */
function normalizeResetsAt(value: unknown): string | null {
	if (typeof value === "string") {
		const ms = new Date(value).getTime();
		return Number.isFinite(ms) ? value : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		const date = new Date(value);
		return Number.isFinite(date.getTime()) ? date.toISOString() : null;
	}
	return null;
}

/**
 * A window is usable only when it carries a numeric `percent`. The value is
 * clamped to 0-100 so a misbehaving upstream can never paint a bar past full
 * or below empty. The raw percentage is preserved for routing decisions:
 * `isUsageExhausted` treats `>= 100` as exhausted, so rounding (e.g. 99.96 up
 * to 100) would bench an account that still has quota. Any display rounding
 * belongs to the UI.
 */
function normalizeWindow(value: unknown): UsageWindowData | null {
	if (!value || typeof value !== "object") return null;
	const w = value as { percent?: unknown; resetsAt?: unknown };
	const percent = w.percent;
	if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
	const clamped = Math.min(100, Math.max(0, percent));
	return {
		utilization: clamped,
		resets_at: normalizeResetsAt(w.resetsAt),
	};
}

/**
 * Fetch OpenCode Go usage. Non-blocking: any failure returns null and never
 * throws, so usage polling cannot affect provider operation.
 */
export async function fetchOpencodeGoUsageData(
	apiKey: string,
): Promise<OpencodeGoUsageData | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		OPENCODE_GO_USAGE_REQUEST_TIMEOUT_MS,
	);
	try {
		const response = await fetch(OPENCODE_GO_USAGE_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const statusText = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			const context = {
				status: response.status,
				statusText,
				url: OPENCODE_GO_USAGE_ENDPOINT,
				headers: responseHeaders,
				timestamp: new Date().toISOString(),
			};
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch OpenCode Go usage data: ${response.status} ${statusText}`,
					{ ...context, errorBody },
				);
			} catch {
				log.warn(
					`Failed to fetch OpenCode Go usage data: ${response.status} ${statusText}`,
					context,
				);
			}
			return null;
		}

		// Body read inherits the same abort signal: a stalled response with
		// headers flushed but no body would otherwise block indefinitely.
		const json: unknown = await response.json();
		const usage =
			json && typeof json === "object"
				? (json as { usage?: unknown }).usage
				: undefined;
		if (!usage || typeof usage !== "object") {
			log.warn("Invalid OpenCode Go usage response structure: missing usage");
			return null;
		}

		const result: OpencodeGoUsageData = {
			five_hour: null,
			seven_day: null,
			monthly: null,
		};
		let parsedAny = false;
		for (const [name, upstreamKey] of WINDOW_KEYS) {
			const window = normalizeWindow(
				(usage as Record<string, unknown>)[upstreamKey],
			);
			result[name] = window;
			if (window) parsedAny = true;
		}

		if (!parsedAny) {
			log.warn("Invalid OpenCode Go usage response structure: no windows");
			return null;
		}
		return result;
	} catch (error) {
		log.warn("Error fetching OpenCode Go usage data:", error);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Every window with a utilization, as `{ name, utilization, resetsAt }`.
 * Ties are broken by the later reset: the account is not fully available
 * again until every capped window clears.
 */
function windows(
	usage: OpencodeGoUsageData | null | undefined,
): Array<{ name: OpencodeGoWindowName; utilization: number; resetMs: number }> {
	if (!usage) return [];
	const out: Array<{
		name: OpencodeGoWindowName;
		utilization: number;
		resetMs: number;
	}> = [];
	for (const [name] of WINDOW_KEYS) {
		const window = usage[name];
		if (!window || typeof window.utilization !== "number") continue;
		const ms = window.resets_at ? new Date(window.resets_at).getTime() : NaN;
		out.push({
			name,
			utilization: window.utilization,
			resetMs: Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY,
		});
	}
	return out;
}

function pickWinningWindow(
	usage: OpencodeGoUsageData | null | undefined,
): { name: OpencodeGoWindowName; utilization: number } | null {
	const candidates = windows(usage);
	if (candidates.length === 0) return null;
	return candidates.reduce((prev, current) => {
		if (current.utilization > prev.utilization) return current;
		if (
			current.utilization === prev.utilization &&
			current.resetMs > prev.resetMs
		)
			return current;
		return prev;
	});
}

/**
 * Representative utilization (0-100): the most exhausted of the 5-hour,
 * weekly and monthly windows. Go's limits are a shared pool, so a monthly
 * cap makes the account just as unavailable as a 5-hour one.
 */
export function getRepresentativeOpencodeGoUtilization(
	usage: OpencodeGoUsageData | null,
): number | null {
	return pickWinningWindow(usage)?.utilization ?? null;
}

/**
 * The window that drives {@link getRepresentativeOpencodeGoUtilization},
 * named in Claude terminology ("five_hour" / "seven_day") or "monthly".
 */
export function getRepresentativeOpencodeGoWindow(
	usage: OpencodeGoUsageData | null,
): OpencodeGoWindowName | null {
	return pickWinningWindow(usage)?.name ?? null;
}
