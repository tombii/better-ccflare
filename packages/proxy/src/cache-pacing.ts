/**
 * Cache-aware fan-out pacing.
 *
 * Anthropic's prompt cache entry becomes readable only after the first
 * response begins streaming. The first in-flight request per (session, model)
 * becomes the leader; followers wait for its first body chunk or a bounded
 * cap. CCFLARE_CACHE_PACING_MS controls the cap (0/unset disables pacing).
 *
 * Routing happens after this wait. Pacing observations are therefore
 * route-neutral until the proxy knows which account actually served the
 * request; recordCachePacingRoute() binds that outcome afterward without
 * changing coordination behavior.
 */
import { createHash } from "node:crypto";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("CachePacing");
export const CACHE_PACING_MS_ENV = "CCFLARE_CACHE_PACING_MS";
export const CODEX_PACING_BYPASS_PERCENT_ENV =
	"CCFLARE_CODEX_PACING_BYPASS_PERCENT";
const MAX_ROUTE_STATS = 256;

interface LeaderEntry {
	promise: Promise<void>;
	resolve: () => void;
	startedAt: number;
}

const leaders = new Map<string, LeaderEntry>();

export type CachePacingReleaseReason = "leader" | "cap";

export interface CachePacingObservation {
	readonly key: string;
	readonly role: "leader" | "follower";
	readonly waitedMs: number;
	readonly releaseReason: CachePacingReleaseReason | null;
	readonly slot: CachePacingSlot | null;
}

export interface CachePacingTarget {
	accountId: string;
	accountName: string;
	provider: string;
}

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

export interface CachePacingRouteStats extends CachePacingFamilyStats {
	accountId: string;
	accountName: string;
	provider: string;
	requestsServed: number;
	canaryBypassServed: number;
	canaryControlServed: number;
	canaryCrossovers: number;
}

const statsByFamily = new Map<string, CachePacingFamilyStats>();
const statsByRoute = new Map<string, CachePacingRouteStats>();
function pacingFamily(model: string | null | undefined): string {
	if (!model) return "unknown";
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt") || /^o\d/.test(model)) return "openai";
	return "other";
}

function newStats(): CachePacingFamilyStats {
	return {
		leaders: 0,
		leadersAbandoned: 0,
		staleLeadersReplaced: 0,
		followersHeld: 0,
		followersReleasedByLeader: 0,
		followersReleasedByCap: 0,
		followerWaitMsTotal: 0,
		followerWaitMsMax: 0,
	};
}

function familyStats(model: string | null | undefined): CachePacingFamilyStats {
	const family = pacingFamily(model);
	let entry = statsByFamily.get(family);
	if (!entry) {
		entry = newStats();
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

export function getCachePacingRouteStats(): Record<
	string,
	CachePacingRouteStats
> {
	return Object.fromEntries(
		[...statsByRoute.entries()].map(([accountId, entry]) => [
			accountId,
			{ ...entry },
		]),
	);
}

/**
 * Attribute a completed pacing observation to the account that actually
 * served it. This must be called only after a successful proxyWithAccount
 * result, never for merely selected, throttled, or failed accounts.
 */
export function recordCachePacingRoute(
	observation: CachePacingObservation | null,
	target: CachePacingTarget,
	canary?: { candidate: boolean; bypassed: boolean },
): void {
	// Route volume and cohort counts apply even when pacing was disabled or
	// ineligible (observation=null). Only wait/leader mechanics need a receipt.
	let entry = statsByRoute.get(target.accountId);
	if (!entry) {
		if (statsByRoute.size >= MAX_ROUTE_STATS) {
			const oldest = statsByRoute.keys().next().value;
			if (oldest !== undefined) statsByRoute.delete(oldest);
		}
		entry = {
			...newStats(),
			accountId: target.accountId,
			accountName: target.accountName,
			provider: target.provider,
			requestsServed: 0,
			canaryBypassServed: 0,
			canaryControlServed: 0,
			canaryCrossovers: 0,
		};
		statsByRoute.set(target.accountId, entry);
	}
	entry.accountName = target.accountName;
	entry.provider = target.provider;
	entry.requestsServed++;
	if (canary?.candidate) {
		if (canary.bypassed && target.provider === "codex") {
			entry.canaryBypassServed++;
		} else if (canary.bypassed) {
			// Candidate was selected for Codex bypass but ultimately served by a
			// different provider after failover. Keep it out of treatment metrics.
			entry.canaryCrossovers++;
		} else if (target.provider === "codex") {
			entry.canaryControlServed++;
		}
	}
	if (!observation) return;
	if (observation.role === "leader") {
		entry.leaders++;
		return;
	}
	entry.followersHeld++;
	entry.followerWaitMsTotal += observation.waitedMs;
	entry.followerWaitMsMax = Math.max(
		entry.followerWaitMsMax,
		observation.waitedMs,
	);
	if (observation.releaseReason === "cap") entry.followersReleasedByCap++;
	else entry.followersReleasedByLeader++;
}

export interface CachePacingSlot {
	readonly key: string;
	wrap(response: Response): Response;
	abandon(): void;
}

export function readCachePacingMs(): number {
	const raw = process.env[CACHE_PACING_MS_ENV];
	if (raw === undefined || raw === "") return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function readCodexPacingBypassPercent(): number {
	const raw = process.env[CODEX_PACING_BYPASS_PERCENT_ENV];
	if (raw === undefined || raw === "") return 0;
	if (!/^\d+$/.test(raw)) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) ? Math.min(parsed, 100) : 0;
}

/**
 * Privacy-preserving conversation identity for canary assignment. The first
 * message and system prompt are stable across a conversation's turns but
 * distinct across sibling subagents. Only the digest is returned.
 */
export function derivePacingCohortKey(
	sessionKey: string | null | undefined,
	body: Record<string, unknown> | null | undefined,
): string | null {
	if (!sessionKey || !body || !Array.isArray(body.messages)) return null;
	const firstMessage = body.messages[0];
	if (firstMessage === undefined) return null;
	try {
		return createHash("sha256")
			.update(sessionKey)
			.update("\0")
			.update(JSON.stringify(body.system ?? ""))
			.update("\0")
			.update(JSON.stringify(firstMessage))
			.digest("hex");
	} catch {
		return null;
	}
}

/** Stable per-conversation cohort assignment; missing identity is control. */
export function isCodexPacingBypassCandidate(
	cohortKey: string | null | undefined,
	percent: number = readCodexPacingBypassPercent(),
): boolean {
	if (!cohortKey || readCachePacingMs() <= 0 || percent <= 0) return false;
	if (percent >= 100) return true;
	const bucket = createHash("sha256")
		.update(cohortKey)
		.digest()
		.readUInt16BE(0);
	return bucket % 100 < percent;
}

/** Full two-phase API used by the proxy. */
export async function observeCachePacing(opts: {
	sessionKey: string | null | undefined;
	model?: string | null;
	now?: () => number;
}): Promise<CachePacingObservation | null> {
	const maxHoldMs = readCachePacingMs();
	if (maxHoldMs <= 0 || !opts.sessionKey) return null;
	const nowFn = opts.now ?? Date.now;
	const key = `${opts.sessionKey}::${opts.model ?? ""}`;
	const stats = familyStats(opts.model);

	const existing = leaders.get(key);
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
		if (releasedByLeader) stats.followersReleasedByLeader++;
		else stats.followersReleasedByCap++;
		stats.followerWaitMsTotal += waitedMs;
		stats.followerWaitMsMax = Math.max(stats.followerWaitMsMax, waitedMs);
		log.info(
			`held follower ${waitedMs}ms behind leader for ${previewKey(key)}`,
		);
		return {
			key,
			role: "follower",
			waitedMs,
			releaseReason: releasedByLeader ? "leader" : "cap",
			slot: null,
		};
	}
	if (existing) stats.staleLeadersReplaced++;

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
		if (leaders.get(key) === entry) leaders.delete(key);
	};
	const slot: CachePacingSlot = {
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
	return { key, role: "leader", waitedMs: 0, releaseReason: null, slot };
}

/** Compatibility wrapper for existing callers and tests. */
export async function acquireCachePacing(opts: {
	sessionKey: string | null | undefined;
	model?: string | null;
	now?: () => number;
}): Promise<CachePacingSlot | null> {
	return (await observeCachePacing(opts))?.slot ?? null;
}

export function finishPacing(
	slot: CachePacingSlot | null,
	response: Response,
): Response {
	if (!slot) return response;
	if (response.ok) return slot.wrap(response);
	slot.abandon();
	return response;
}

export function resetCachePacing(): void {
	leaders.clear();
	statsByFamily.clear();
	statsByRoute.clear();
}

function previewKey(key: string): string {
	return key.length <= 40 ? key : `${key.slice(0, 40)}...`;
}
