/**
 * Cache-aware fan-out pacing.
 *
 * Anthropic's prompt cache entry becomes readable only after the first
 * response begins streaming. When a client fans out N parallel requests that
 * share a prompt prefix (Claude Code subagent bursts), all N miss the cache
 * and each pays the full cache-write price for the shared prefix. The
 * documented pattern is: send one request, await its first streamed byte,
 * then release the rest so they read the cache the leader just wrote.
 *
 * This module implements that pattern at the proxy: the first in-flight
 * request per (session, model) becomes the leader; concurrent followers are
 * held until the leader's first body chunk arrives or a bounded cap expires.
 * The wall-clock cost to a follower is roughly zero, because uncached prefill
 * would have taken it about as long as the leader's time-to-first-byte, while
 * the token saving is the full shared prefix per follower.
 *
 *   CCFLARE_CACHE_PACING_MS   max follower hold in ms (0 or unset = disabled)
 *
 * Failure containment: every leader exit path must call wrap() or abandon().
 * If a leader dies without either (unexpected throw), followers still release
 * at the cap, so a bug here degrades to today's behavior, never a deadlock.
 */
import { Logger } from "@better-ccflare/logger";

const log = new Logger("CachePacing");

export const CACHE_PACING_MS_ENV = "CCFLARE_CACHE_PACING_MS";

interface LeaderEntry {
	promise: Promise<void>;
	resolve: () => void;
	startedAt: number;
}

const leaders = new Map<string, LeaderEntry>();

/**
 * Rolling in-process counters, grouped by provider family. Production runs at
 * WARN log level, which hides the per-request INFO hold lines, so these
 * counters (served via GET /api/debug/cache-pacing) are the only always-on
 * view of what pacing actually does: how often followers are held, for how
 * long, and whether they release on the leader's first byte or time out at
 * the cap. Counters reset on process restart.
 */
export interface CachePacingFamilyStats {
	leaders: number;
	leadersAbandoned: number;
	staleLeadersReplaced: number;
	followersHeld: number;
	followersReleasedByLeader: number;
	followersReleasedByCap: number;
	followerWaitMsTotal: number;
	followerWaitMsMax: number;
}

const statsByFamily = new Map<string, CachePacingFamilyStats>();

function pacingFamily(model: string | null | undefined): string {
	if (!model) return "unknown";
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt") || /^o\d/.test(model)) return "openai";
	return "other";
}

function familyStats(model: string | null | undefined): CachePacingFamilyStats {
	const family = pacingFamily(model);
	let entry = statsByFamily.get(family);
	if (!entry) {
		entry = {
			leaders: 0,
			leadersAbandoned: 0,
			staleLeadersReplaced: 0,
			followersHeld: 0,
			followersReleasedByLeader: 0,
			followersReleasedByCap: 0,
			followerWaitMsTotal: 0,
			followerWaitMsMax: 0,
		};
		statsByFamily.set(family, entry);
	}
	return entry;
}

export function getCachePacingStats(): Record<string, CachePacingFamilyStats> {
	return Object.fromEntries(
		[...statsByFamily.entries()].map(([family, entry]) => [
			family,
			{ ...entry },
		]),
	);
}

export interface CachePacingSlot {
	readonly key: string;
	/**
	 * Leader success path: returns a pass-through copy of the response whose
	 * first body chunk releases waiting followers. Marks the slot done.
	 */
	wrap(response: Response): Response;
	/** Leader failure path: release followers immediately. Idempotent. */
	abandon(): void;
}

export function readCachePacingMs(): number {
	const raw = process.env[CACHE_PACING_MS_ENV];
	if (raw === undefined || raw === "") return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Returns a leader slot when this request should lead its (session, model)
 * group, or null when pacing is disabled, inapplicable, or this request was
 * held as a follower and has now been released.
 */
export async function acquireCachePacing(opts: {
	sessionKey: string | null | undefined;
	model?: string | null;
	now?: () => number;
}): Promise<CachePacingSlot | null> {
	const maxHoldMs = readCachePacingMs();
	if (maxHoldMs <= 0 || !opts.sessionKey) return null;
	const nowFn = opts.now ?? Date.now;
	const key = `${opts.sessionKey}::${opts.model ?? ""}`;
	const stats = familyStats(opts.model);

	const existing = leaders.get(key);
	// A leader older than twice the cap is considered dead (its followers have
	// long since released at the cap); replace it rather than waiting on it.
	if (existing && nowFn() - existing.startedAt < maxHoldMs * 2) {
		const heldStart = nowFn();
		stats.followersHeld++;
		let capTimer: ReturnType<typeof setTimeout> | undefined;
		const releasedByLeader = await Promise.race([
			existing.promise.then(() => true),
			new Promise<boolean>((resolve) => {
				capTimer = setTimeout(() => resolve(false), maxHoldMs);
			}),
		]);
		if (capTimer !== undefined) clearTimeout(capTimer);
		const waitedMs = nowFn() - heldStart;
		if (releasedByLeader) {
			stats.followersReleasedByLeader++;
		} else {
			stats.followersReleasedByCap++;
		}
		stats.followerWaitMsTotal += waitedMs;
		if (waitedMs > stats.followerWaitMsMax) {
			stats.followerWaitMsMax = waitedMs;
		}
		log.info(
			`held follower ${waitedMs}ms behind leader for ${previewKey(key)}`,
		);
		return null;
	}
	if (existing) {
		stats.staleLeadersReplaced++;
	}

	// Become the leader. No await between the check above and this set, so
	// registration is atomic on the event loop.
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	const entry: LeaderEntry = { promise, resolve, startedAt: nowFn() };
	leaders.set(key, entry);
	stats.leaders++;

	let done = false;
	const finish = () => {
		entry.resolve();
		if (leaders.get(key) === entry) {
			leaders.delete(key);
		}
	};

	return {
		key,
		wrap(response: Response): Response {
			if (done) return response;
			done = true;
			if (!response.body) {
				finish();
				return response;
			}
			let released = false;
			const releaseOnce = () => {
				if (!released) {
					released = true;
					finish();
				}
			};
			const passThrough = new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					releaseOnce();
					controller.enqueue(chunk);
				},
				flush() {
					releaseOnce();
				},
			});
			return new Response(response.body.pipeThrough(passThrough), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		},
		abandon(): void {
			if (done) return;
			done = true;
			stats.leadersAbandoned++;
			finish();
		},
	};
}

/**
 * Uniform helper for leader return sites: successful responses are wrapped so
 * followers release on first byte; failures release followers immediately.
 */
export function finishPacing(
	slot: CachePacingSlot | null,
	response: Response,
): Response {
	if (!slot) return response;
	if (response.ok) {
		return slot.wrap(response);
	}
	slot.abandon();
	return response;
}

/** Test hook: clear all leader state and rolling stats. */
export function resetCachePacing(): void {
	leaders.clear();
	statsByFamily.clear();
}

function previewKey(key: string): string {
	return key.length <= 40 ? key : `${key.slice(0, 40)}...`;
}
