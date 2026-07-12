/**
 * Session volume circuit breaker.
 *
 * A runaway subagent storm (model-driven recursive fan-out) shows up at the
 * proxy as one client session hammering /v1/messages far beyond interactive
 * rates. Concurrency limiting alone does not stop it: a queued storm drains
 * patiently and still burns the entire upstream usage window. This governor
 * counts requests per client session over a rolling hour and, when
 * enforcement is enabled, rejects the overflow with an Anthropic-shaped 429
 * before account selection touches upstream quota.
 *
 * Defaults are deliberately observability-first for upstream friendliness:
 * warnings are on, enforcement is off until a budget is configured.
 *
 *   CCFLARE_SESSION_WARN_REQUESTS_PER_HOUR   warn threshold (default 300)
 *   CCFLARE_SESSION_MAX_REQUESTS_PER_HOUR    reject threshold (default 0 = off)
 *
 * Legitimate heavy sessions (e.g. a bounded 20-agent workflow) burst wide but
 * finish; a recursive storm keeps growing. Budgets should therefore sit well
 * above normal workflow bursts and trip only on sustained volume.
 *
 * State is process-local by design: better-ccflare runs as a single-process
 * local proxy. A multi-replica deployment without session-affinity routing
 * would multiply the effective budget by the replica count; that setup needs
 * shared state (or affinity) and is out of scope here.
 */
import { Logger } from "@better-ccflare/logger";

const log = new Logger("SessionGovernor");

export const SESSION_GOVERNOR_WARN_ENV =
	"CCFLARE_SESSION_WARN_REQUESTS_PER_HOUR";
export const SESSION_GOVERNOR_MAX_ENV = "CCFLARE_SESSION_MAX_REQUESTS_PER_HOUR";

const WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_WARN_PER_HOUR = 300;
/** Enforcement is opt-in: 0 disables rejection, warnings stay on. */
const DEFAULT_MAX_PER_HOUR = 0;
/** Memory bound for tracked sessions; oldest entries are swept past this. */
const MAX_TRACKED_SESSIONS = 2048;
/**
 * Per-session history bound: with enforcement on, rejected requests are not
 * appended so history never exceeds the budget; in warn-only mode a runaway
 * session saturates here (counts read "at least this many") instead of
 * growing without bound.
 */
const MAX_TRACKED_TIMES = 20_000;
/** Housekeeping cadence independent of map capacity. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

interface SessionWindow {
	times: number[];
	warned: boolean;
}

const sessions = new Map<string, SessionWindow>();

export interface SessionGovernorVerdict {
	key: string;
	/** Requests in the rolling window, including this one. */
	count: number;
	warnLimit: number;
	maxLimit: number;
	rejected: boolean;
	/** Seconds until the oldest admitted request leaves the window. */
	retryAfterSec: number | null;
}

/**
 * Record one /v1/messages request for a session and return the verdict.
 * Returns null when the client sent no session identity; anonymous traffic
 * is not governed (it cannot be attributed to a single runaway loop).
 */
export function recordSessionRequest(
	sessionKey: string | null | undefined,
	now: number = Date.now(),
): SessionGovernorVerdict | null {
	if (!sessionKey) return null;

	const warnLimit = readLimit(SESSION_GOVERNOR_WARN_ENV, DEFAULT_WARN_PER_HOUR);
	const maxLimit = readLimit(SESSION_GOVERNOR_MAX_ENV, DEFAULT_MAX_PER_HOUR);

	// Periodic housekeeping independent of map capacity, so an idle session's
	// history does not persist until the map happens to fill up.
	if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
		lastSweepAt = now;
		sweep(now);
	}

	let window = sessions.get(sessionKey);
	if (!window) {
		if (sessions.size >= MAX_TRACKED_SESSIONS) {
			sweep(now);
		}
		window = { times: [], warned: false };
		sessions.set(sessionKey, window);
	}

	// Timestamps are appended in order, so expired entries form a prefix.
	// Splice that prefix off only when something actually expired: filtering
	// the whole array on every request would make a runaway session cost
	// quadratic time and stall the event loop, the exact storm being governed.
	const cutoff = now - WINDOW_MS;
	let expired = 0;
	while (expired < window.times.length && window.times[expired] <= cutoff) {
		expired++;
	}
	if (expired > 0) {
		window.times.splice(0, expired);
	}
	if (window.times.length === 0) {
		window.warned = false;
	}

	const count = window.times.length + 1;
	const rejected = maxLimit > 0 && count > maxLimit;
	// A rejected request consumes no budget: appending it would let a client
	// retrying every few minutes hold the session over its limit forever,
	// turning a temporary 429 into a permanent lockout.
	if (!rejected && window.times.length < MAX_TRACKED_TIMES) {
		window.times.push(now);
	}
	const retryAfterSec = rejected
		? Math.max(1, Math.ceil((window.times[0] + WINDOW_MS - now) / 1000))
		: null;

	if (!rejected && warnLimit > 0 && count >= warnLimit && !window.warned) {
		window.warned = true;
		log.warn(
			`session ${previewKey(sessionKey)} reached ${count} requests in the last hour (warn threshold ${warnLimit}). Possible runaway subagent fan-out.`,
		);
	}

	return {
		key: sessionKey,
		count,
		warnLimit,
		maxLimit,
		rejected,
		retryAfterSec,
	};
}

/** Anthropic-shaped 429 for a rejected verdict. */
export function buildSessionRejectResponse(
	verdict: SessionGovernorVerdict,
): Response {
	log.error(
		`session ${previewKey(verdict.key)} exceeded the session budget: ${verdict.count} requests in the last hour (limit ${verdict.maxLimit}). Rejecting with 429.`,
	);
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: `better-ccflare session budget exceeded: ${verdict.count} requests in the last hour (limit ${verdict.maxLimit}). This usually indicates runaway subagent fan-out. Raise ${SESSION_GOVERNOR_MAX_ENV} to increase the budget or set it to 0 to disable enforcement.`,
			},
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json",
				// Marks this as a deliberate policy rejection (not transient
				// upstream capacity) so fronting proxies pass it to the client
				// instead of retry-holding it.
				"x-better-ccflare-governor": "session-budget",
				// Honest hint: when the oldest admitted request leaves the
				// window, one slot frees up.
				"retry-after": String(verdict.retryAfterSec ?? 300),
			},
		},
	);
}

/** Test hook: clear all tracked sessions. */
export function resetSessionGovernor(): void {
	sessions.clear();
	lastSweepAt = 0;
}

function readLimit(envName: string, fallback: number): number {
	const raw = process.env[envName];
	if (raw === undefined || raw === "") return fallback;
	// Strict digits only: parseInt would accept prefixes like "1e5" as 1 or
	// "0x10" as 0, silently turning a generous budget into a near-zero one.
	if (!/^\d+$/.test(raw)) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sweep(now: number): void {
	const cutoff = now - WINDOW_MS;
	for (const [key, window] of sessions) {
		const newest = window.times[window.times.length - 1];
		if (newest === undefined || newest <= cutoff) {
			sessions.delete(key);
		}
	}
	// Hard bound even if every session is active: evict the least recently
	// active sessions first. Insertion order would evict a long-running
	// runaway session (the exact thing being governed) and let it restart
	// counting from zero; least-recent-activity eviction keeps the busiest
	// offenders tracked.
	if (sessions.size >= MAX_TRACKED_SESSIONS) {
		const excess = sessions.size - MAX_TRACKED_SESSIONS + 1;
		const byLastActivity = [...sessions.entries()]
			.map(
				([key, window]) =>
					[key, window.times[window.times.length - 1] ?? 0] as const,
			)
			.sort((a, b) => a[1] - b[1]);
		for (let i = 0; i < excess && i < byLastActivity.length; i++) {
			sessions.delete(byLastActivity[i][0]);
		}
	}
}

function previewKey(key: string): string {
	return key.length <= 24 ? key : `${key.slice(0, 24)}...`;
}
