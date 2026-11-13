/**
 * The per-API-key spend counter.
 *
 * WHY THIS EXISTS AT ALL. The obvious implementation of a spend limit is one
 * rollup per proxied request:
 *
 *     SELECT SUM(cost_usd) FROM requests WHERE api_key_id = ? AND timestamp > ?
 *
 * That is not viable here. Measured against live production data, one key
 * carried 282,000 requests in 30 days and that rollup took 264ms. The covering
 * indexes on `requests` deliberately omit the api-key columns, so the query
 * walks idx_requests_api_key_timestamp and then heap-looks-up every matched
 * row for `cost_usd`. Putting a quarter of a second of database work in front
 * of every request is worse than having no limit feature.
 *
 * So the total is held in memory, per key, and the rollup runs three times
 * only: once at startup for each key that has a limit, once the first time an
 * unseeded limited key is seen (a limit set while the process was running),
 * and then on a TTL to correct drift.
 *
 * ── TWO INHERENT INACCURACIES, both deliberate and neither fixable here ──
 *
 * 1. OVERSHOOT BY ONE IN-FLIGHT REQUEST. A request's cost is not known until
 *    it completes — it is computed from the response's token usage. The check
 *    therefore runs against the spend BEFORE this request, and a key can
 *    always exceed its limit by roughly the cost of whatever is in flight when
 *    it crosses. With concurrent clients it is one such cost per concurrent
 *    request. There is no version of a post-hoc cost that avoids this; the
 *    alternative would be pre-charging an estimate and refunding it, which
 *    would refuse requests that would have fit. The limit is a budget, not a
 *    hard cap, and the refusal message says "exceeded", not "would exceed".
 *
 * 2. DIVERGENCE ACROSS PROCESSES. Two instances sharing one database each keep
 *    their own counter and each see only their own traffic between resyncs, so
 *    their totals converge only at each TTL boundary and the combined spend can
 *    overshoot by up to one TTL of the other instance's traffic. This is the
 *    same class of in-process coordination state that
 *    packages/database/src/multi-instance-guard.ts already enumerates and warns
 *    about at startup (sticky session maps, recency penalties, the usage cache,
 *    the refresh mutex); this counter is another entry on that list, and the
 *    same single-instance-ownership assumption applies. The resync is what
 *    bounds the divergence rather than eliminating it.
 *
 * The resync also repairs drift from a third source: the request row is written
 * by AsyncDbWriter, which can drop a write under backpressure or on an abrupt
 * shutdown. The in-memory increment and the persisted row can therefore
 * disagree, and the database is the one that wins at the next resync.
 */

import {
	API_KEY_ROLLING_DURATION_MS,
	apiKeyLimitWindowBounds,
	computeSpendWindowResetMs,
	computeSpendWindowStartMs,
	spendWindowInstanceKey,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type {
	ApiKeyLimit,
	ApiKeyLimitWindowMode,
	ApiKeySpendLimit,
} from "@better-ccflare/types";

const log = new Logger("ApiKeySpend");

import { isModelAllowedForApiKey } from "./api-key-restrictions";

/**
 * How long a cached total may go without being re-read from the database.
 *
 * TWO MINUTES, chosen against the two things the TTL trades off:
 *
 *  - It bounds the error. It is the maximum staleness of a rolling window's
 *    total (spend that has aged out is still counted until the next resync),
 *    and the maximum a second instance's traffic can go unseen. Two minutes of
 *    a 7-day window is 0.02% of the window; even at the pathological rate of
 *    the 282k-requests-per-month key, it is a few dollars.
 *
 *  - It bounds the cost. The resync is the 264ms worst-case rollup. At a
 *    2-minute TTL that is a 0.22% duty cycle per actively-used limited key on
 *    a database that is also serving the dashboard; at 30 seconds it would be
 *    ~1% per key and would start to contend.
 *
 * The resync itself is fired in the BACKGROUND and never awaited on the proxy
 * path, so even a slow one costs a request nothing — it just means the answer
 * that request used was up to one TTL old, which is exactly the error budget
 * above. Only the very first sync for a key is awaited, because the
 * alternative there is answering from a total of zero, which would let a key
 * that is already over its limit through until the seed lands.
 */
export const SPEND_RESYNC_TTL_MS = 2 * 60 * 1000;

/** What a caller learns about a key's position against its limit. */
export interface SpendSnapshot {
	/** Spend counted in the current window, in API-cost-equivalent dollars. */
	spentUsd: number;
	/** The limit this was measured against. */
	limitUsd: number;
	/** Epoch ms when this window's spend next falls; null when unknown. */
	resetMs: number | null;
	/** `spentUsd >= limitUsd`. */
	exceeded: boolean;
}

interface CounterEntry {
	/** Identity of the window instance this total belongs to. */
	windowKey: string;
	/** Lower bound the total was measured from. */
	windowStartMs: number;
	spentUsd: number;
	/** Oldest counted request, for a rolling window's relief time. */
	oldestSpendMs: number | null;
	/** When the total was last read from the database. */
	lastSyncMs: number;
}

/**
 * In-memory spend totals for the keys that have a limit.
 *
 * Keys WITHOUT a limit never get an entry: `record()` ignores them, and the
 * counter is never consulted for them. A deployment with no spend limits
 * configured therefore carries an empty Map and no query of any kind.
 */
export class ApiKeySpendCounter {
	private readonly entries = new Map<string, CounterEntry>();
	/** De-duplicates concurrent first-syncs for the same key. */
	private readonly inflight = new Map<string, Promise<CounterEntry>>();

	private readonly limitEntries = new Map<
		string,
		{
			apiKeyId: string;
			limit: ApiKeyLimit;
			mode: ApiKeyLimitWindowMode;
			startMs: number;
			endMs: number;
			lastSyncMs: number;
			spentUsd: number;
			cursor: number;
			events: Array<{
				requestId?: string;
				timestamp: number;
				costUsd: number;
				model: string | null;
			}>;
		}
	>();
	private readonly limitInflight = new Map<string, Promise<void>>();
	private readonly limitGenerations = new Map<string, number>();
	private readonly limitSyncTokens = new Map<string, symbol>();
	private readonly pendingRecords = new Map<
		string,
		{
			apiKeyId: string;
			scopeModel: string | null;
			events: Array<{
				requestId: string;
				timestamp: number;
				costUsd: number;
				model: string | null;
			}>;
		}
	>();
	private readonly keyLimits = new Map<
		string,
		{ loadedMs: number; limits: ApiKeyLimit[] }
	>();
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	constructor(private readonly dbOps: DatabaseOperations) {}
	dispose(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
	}
	private scheduleRefresh(): void {
		this.dispose();
		if (!this.limitEntries.size) return;
		const now = Date.now();
		let next = now + SPEND_RESYNC_TTL_MS;
		for (const entry of this.limitEntries.values())
			if (entry.mode === "calendar")
				next = Math.min(
					next,
					apiKeyLimitWindowBounds(entry.limit.window, entry.mode, now).endMs,
				);
		this.refreshTimer = setTimeout(
			() => {
				this.refreshTimer = null;
				void Promise.all(
					[...this.limitEntries.values()].map((entry) =>
						this.getLimitSnapshot(
							entry.apiKeyId,
							entry.limit,
							entry.mode,
							Date.now(),
							true,
						).catch((error) =>
							log.warn(
								`Spend counter scheduled reconciliation failed: ${String(error)}`,
							),
						),
					),
				).finally(() => this.scheduleRefresh());
			},
			Math.max(1, next - now),
		);
		this.refreshTimer.unref();
	}
	async getLimitsForKey(apiKeyId: string): Promise<ApiKeyLimit[]> {
		const cached = this.keyLimits.get(apiKeyId);
		if (cached && Date.now() - cached.loadedMs < SPEND_RESYNC_TTL_MS)
			return cached.limits;
		const generation = this.limitGenerations.get(apiKeyId) ?? 0;
		const limits = await this.dbOps.getApiKeyLimits(apiKeyId);
		if ((this.limitGenerations.get(apiKeyId) ?? 0) !== generation)
			return this.getLimitsForKey(apiKeyId);
		this.keyLimits.set(apiKeyId, { loadedMs: Date.now(), limits });
		return limits;
	}
	async getLimitSnapshot(
		apiKeyId: string,
		limit: ApiKeyLimit,
		mode: ApiKeyLimitWindowMode,
		nowMs = Date.now(),
		reconcile = false,
	): Promise<SpendSnapshot> {
		const identity = JSON.stringify([apiKeyId, limit.scopeModel, limit.window]);
		const bounds = apiKeyLimitWindowBounds(limit.window, mode, nowMs);
		const generation = this.limitGenerations.get(apiKeyId) ?? 0;
		const inflightIdentity = JSON.stringify([
			identity,
			generation,
			mode,
			mode === "calendar" ? bounds.startMs : null,
		]);
		let entry = this.limitEntries.get(identity);
		const sync = async () => {
			let pending = this.limitInflight.get(inflightIdentity);
			if (!pending) {
				const token = Symbol();
				this.limitSyncTokens.set(identity, token);
				const buffered = {
					apiKeyId,
					scopeModel: limit.scopeModel,
					events: [] as Array<{
						requestId: string;
						timestamp: number;
						costUsd: number;
						model: string | null;
					}>,
				};
				this.pendingRecords.set(inflightIdentity, buffered);
				pending = this.dbOps
					.getApiKeySpendEventsSince(apiKeyId, bounds.startMs)
					.then((events) => {
						if (
							(this.limitGenerations.get(apiKeyId) ?? 0) !== generation ||
							this.limitSyncTokens.get(identity) !== token
						)
							throw new Error(
								"Spend counter reconciliation superseded by updated settings",
							);
						// An async SQL snapshot can race a completed request's increment.
						// Merge buffered completions by request ID so a query which already
						// saw the persisted request neither loses nor duplicates that spend.
						const seen = new Set(
							events.map((event) => event.requestId).filter(Boolean),
						);
						const bufferedIds = new Set(
							buffered.events.map((event) => event.requestId),
						);
						const merged = [
							...events,
							...buffered.events.filter((event) => !seen.has(event.requestId)),
						].sort((a, b) => a.timestamp - b.timestamp);
						const matching = merged.filter(
							(event) =>
								(event.timestamp <= nowMs ||
									(event.requestId != null &&
										bufferedIds.has(event.requestId))) &&
								(mode !== "rolling" || event.timestamp > bounds.startMs) &&
								(mode !== "calendar" || event.timestamp < bounds.endMs) &&
								this.matchesScope(event.model, limit.scopeModel),
						);
						this.limitEntries.set(identity, {
							apiKeyId,
							limit,
							mode,
							...bounds,
							lastSyncMs: nowMs,
							events: matching,
							cursor: 0,
							spentUsd: matching.reduce(
								(total, event) => total + event.costUsd,
								0,
							),
						});
					})
					.finally(() => {
						if (this.pendingRecords.get(inflightIdentity) === buffered)
							this.pendingRecords.delete(inflightIdentity);
						if (this.limitInflight.get(inflightIdentity) === pending)
							this.limitInflight.delete(inflightIdentity);
					});
				this.limitInflight.set(inflightIdentity, pending);
			}
			await pending;
		};
		if (
			reconcile ||
			!entry ||
			entry.mode !== mode ||
			(mode === "calendar" && entry.startMs !== bounds.startMs)
		) {
			await sync();
			entry = this.limitEntries.get(identity);
		} else if (nowMs - entry.lastSyncMs >= SPEND_RESYNC_TTL_MS) {
			void sync().catch((error) =>
				log.warn(
					`Spend counter resync failed for key ${apiKeyId}: ${String(error)}`,
				),
			);
		}
		if ((this.limitGenerations.get(apiKeyId) ?? 0) !== generation)
			throw new Error("Spend counter settings changed during check");
		if (!entry) throw new Error("Spend counter failed to initialize");
		entry.limit = limit;
		while (
			entry.cursor < entry.events.length &&
			(mode === "rolling"
				? entry.events[entry.cursor].timestamp <= bounds.startMs
				: entry.events[entry.cursor].timestamp < bounds.startMs)
		) {
			entry.spentUsd -= entry.events[entry.cursor++].costUsd;
		}
		if (entry.cursor > 1000 && entry.cursor > entry.events.length / 2) {
			entry.events = entry.events.slice(entry.cursor);
			entry.cursor = 0;
		}
		const spentUsd = Math.max(0, entry.spentUsd);

		let resetMs: number | null = bounds.endMs;
		if (mode === "rolling") {
			resetMs = null;
			let remaining = spentUsd;
			for (let i = entry.cursor; i < entry.events.length; i++) {
				const event = entry.events[i];
				remaining -= event.costUsd;
				resetMs = Math.min(
					nowMs + API_KEY_ROLLING_DURATION_MS[limit.window],
					event.timestamp + API_KEY_ROLLING_DURATION_MS[limit.window],
				);
				if (remaining < limit.limitUsd) break;
			}
		}
		if (Math.abs(Date.now() - nowMs) < 1000 && !this.refreshTimer)
			this.scheduleRefresh();
		return {
			spentUsd,
			limitUsd: limit.limitUsd,
			resetMs,
			exceeded: spentUsd >= limit.limitUsd,
		};
	}
	private matchesScope(
		model: string | null | undefined,
		scope: string | null,
	): boolean {
		return (
			scope == null ||
			(!!model &&
				isModelAllowedForApiKey(model, {
					allowedModels: [scope],
					allowedAccounts: null,
					allowedProviders: null,
				}))
		);
	}

	/**
	 * Seed one total per key that currently has a limit.
	 *
	 * Called once at startup. Failures are logged and swallowed: a counter
	 * that could not be seeded falls back to seeding lazily on first use, and
	 * a database hiccup at boot must not stop the proxy from starting.
	 */
	async seedAll(): Promise<number> {
		let seeded = 0;
		try {
			const keys = await this.dbOps.listApiKeysWithSpendLimits();
			for (const key of keys) {
				if (typeof this.dbOps.getApiKeyLimits === "function") {
					try {
						const limits = await this.getLimitsForKey(key.id);
						for (const limit of limits)
							await this.getLimitSnapshot(
								key.id,
								limit,
								key.limitWindowMode ?? "calendar",
							);
						seeded++;
					} catch (error) {
						log.warn(
							`Failed to seed spend counter for key ${key.name}: ${String(error)}`,
						);
					}
					continue;
				}
				const limit = {
					limitUsd: key.limitUsd ?? 0,
					limitWindow: key.limitWindow ?? "rolling_30d",
					limitEnforce: key.limitEnforce ?? "block",
				} as ApiKeySpendLimit;
				if (!(limit.limitUsd > 0)) continue;
				try {
					await this.sync(key.id, limit, Date.now());
					seeded++;
				} catch (error) {
					log.warn(
						`Failed to seed spend counter for key ${key.name}: ${(error as Error).message}`,
					);
				}
			}
			if (seeded > 0) {
				log.info(`Seeded spend counters for ${seeded} API key(s)`);
			}
		} catch (error) {
			log.warn(
				`Could not list keys with spend limits; counters will seed lazily: ${(error as Error).message}`,
			);
		}
		return seeded;
	}

	/**
	 * The key's position against its limit right now.
	 *
	 * Awaits the database only on the FIRST call for a key (see
	 * SPEND_RESYNC_TTL_MS for why every later refresh is fired into the
	 * background instead).
	 */
	async getSnapshot(
		apiKeyId: string,
		limit: ApiKeySpendLimit,
		nowMs: number = Date.now(),
	): Promise<SpendSnapshot> {
		const windowKey = spendWindowInstanceKey(limit.limitWindow, nowMs);
		let entry = this.entries.get(apiKeyId);

		if (!entry || entry.windowKey !== windowKey) {
			// No total yet, or the calendar window rolled over and the old
			// total belongs to a month that has closed. Either way the cached
			// value is not an answer to the question being asked, so this one
			// waits for the database rather than reporting zero.
			entry = await this.syncOnce(apiKeyId, limit, nowMs);
		} else if (nowMs - entry.lastSyncMs >= SPEND_RESYNC_TTL_MS) {
			// Stale but usable: answer from what we have and refresh behind it.
			void this.syncOnce(apiKeyId, limit, nowMs).catch((error) => {
				log.warn(
					`Spend counter resync failed for key ${apiKeyId}: ${(error as Error).message}`,
				);
			});
		}

		return {
			spentUsd: entry.spentUsd,
			limitUsd: limit.limitUsd,
			resetMs: computeSpendWindowResetMs(
				limit.limitWindow,
				nowMs,
				entry.oldestSpendMs,
			),
			exceeded: entry.spentUsd >= limit.limitUsd,
		};
	}

	/**
	 * Add a completed request's cost to the key's total.
	 *
	 * Fire-and-forget and synchronous: called from the usage collector the
	 * moment a cost becomes known, on a path that must not await anything.
	 * A key with no counter entry is ignored — either it has no limit (the
	 * common case, and nothing should be counted) or it has never been
	 * consulted, in which case its first `getSnapshot` will read the true
	 * total from the database including this very request.
	 */
	record(
		apiKeyId: string | null | undefined,
		costUsd: number | undefined,
		model?: string | null,
		timestamp = Date.now(),
		requestId: string = crypto.randomUUID(),
	) {
		if (!apiKeyId) return;
		if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return;
		if (costUsd === 0) return;
		const recorded = { requestId, timestamp, costUsd, model: model ?? null };
		for (const pending of this.pendingRecords.values())
			if (
				pending.apiKeyId === apiKeyId &&
				this.matchesScope(model, pending.scopeModel)
			)
				pending.events.push(recorded);
		for (const entry of this.limitEntries.values()) {
			if (
				entry.apiKeyId !== apiKeyId ||
				!this.matchesScope(model, entry.limit.scopeModel)
			)
				continue;
			const bounds = apiKeyLimitWindowBounds(
				entry.limit.window,
				entry.mode,
				Date.now(),
			);
			if (entry.mode === "calendar" && entry.startMs !== bounds.startMs) {
				entry.events = [];
				entry.spentUsd = 0;
				entry.cursor = 0;
				entry.startMs = bounds.startMs;
				entry.endMs = bounds.endMs;
				entry.lastSyncMs = 0;
			}

			if (
				timestamp < bounds.startMs ||
				(entry.mode === "calendar" && timestamp >= bounds.endMs)
			)
				continue;
			const event = recorded;
			// Requests may finish out of order; preserve timestamp ordering for expiry.
			if (
				entry.events.length &&
				entry.events[entry.events.length - 1].timestamp > timestamp
			) {
				entry.events = entry.events.slice(entry.cursor);
				entry.cursor = 0;
				let index = entry.events.findIndex(
					(current) => current.timestamp > timestamp,
				);
				if (index < 0) index = entry.events.length;
				entry.events.splice(index, 0, event);
			} else entry.events.push(event);
			entry.spentUsd += costUsd;
		}
		const entry = this.entries.get(apiKeyId);
		if (!entry) return;
		entry.spentUsd += costUsd;
		// The oldest counted request only matters for a rolling window's
		// relief time, and an increment can only ever ADD a newer row — so it
		// is left alone here and refreshed by the next resync.
	}

	/** Drop a key's cached total, e.g. after its limit is changed or cleared. */
	forget(apiKeyId: string) {
		this.limitGenerations.set(
			apiKeyId,
			(this.limitGenerations.get(apiKeyId) ?? 0) + 1,
		);
		this.keyLimits.delete(apiKeyId);
		for (const [identity, entry] of this.limitEntries)
			if (entry.apiKeyId === apiKeyId) this.limitEntries.delete(identity);
		this.entries.delete(apiKeyId);
		this.inflight.delete(apiKeyId);
	}

	/** Test seam: the cached total, without triggering a sync. */
	peek(apiKeyId: string): { spentUsd: number; lastSyncMs: number } | null {
		const entry = this.entries.get(apiKeyId);
		return entry
			? { spentUsd: entry.spentUsd, lastSyncMs: entry.lastSyncMs }
			: null;
	}

	/** Number of keys currently being counted. */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * One rollup, de-duplicated across concurrent callers.
	 *
	 * Without this, a burst of requests on a cold key would each fire their
	 * own 264ms rollup at the same instant.
	 */
	private syncOnce(
		apiKeyId: string,
		limit: ApiKeySpendLimit,
		nowMs: number,
	): Promise<CounterEntry> {
		const existing = this.inflight.get(apiKeyId);
		if (existing) return existing;

		const promise = this.sync(apiKeyId, limit, nowMs).finally(() => {
			this.inflight.delete(apiKeyId);
		});
		this.inflight.set(apiKeyId, promise);
		return promise;
	}

	private async sync(
		apiKeyId: string,
		limit: ApiKeySpendLimit,
		nowMs: number,
	): Promise<CounterEntry> {
		const windowStartMs = computeSpendWindowStartMs(limit.limitWindow, nowMs);
		const { totalUsd, oldestMs } = await this.dbOps.getApiKeySpendSince(
			apiKeyId,
			windowStartMs,
		);
		const entry: CounterEntry = {
			windowKey: spendWindowInstanceKey(limit.limitWindow, nowMs),
			windowStartMs,
			spentUsd: totalUsd,
			oldestSpendMs: oldestMs,
			lastSyncMs: nowMs,
		};
		// Replaces rather than merges: the database is authoritative, and
		// anything recorded in memory while this query was in flight is
		// already included in its result or will be re-read at the next
		// resync. Merging would double-count.
		this.entries.set(apiKeyId, entry);
		return entry;
	}
}

let _counter: ApiKeySpendCounter | null = null;

/**
 * The process-wide counter, created on first use.
 *
 * A singleton for the same reason the usage collector is one: the proxy path,
 * the usage collector's increment and the management API's gauge must all read
 * and write the same totals, and they reach it from three different packages.
 */
export function getApiKeySpendCounter(
	dbOps: DatabaseOperations,
): ApiKeySpendCounter {
	if (!_counter) _counter = new ApiKeySpendCounter(dbOps);
	return _counter;
}

/** The counter if one exists, else null — for paths that must not create one. */
export function tryGetApiKeySpendCounter(): ApiKeySpendCounter | null {
	return _counter;
}

/** Test seam. */
export function resetApiKeySpendCounter(): void {
	_counter?.dispose();
	_counter = null;
}
