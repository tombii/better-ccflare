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
	computeSpendWindowResetMs,
	computeSpendWindowStartMs,
	spendWindowInstanceKey,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type { ApiKeySpendLimit } from "@better-ccflare/types";

const log = new Logger("ApiKeySpend");

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

	constructor(private readonly dbOps: DatabaseOperations) {}

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
	record(apiKeyId: string | null | undefined, costUsd: number | undefined) {
		if (!apiKeyId) return;
		if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return;
		if (costUsd === 0) return;
		const entry = this.entries.get(apiKeyId);
		if (!entry) return;
		entry.spentUsd += costUsd;
		// The oldest counted request only matters for a rolling window's
		// relief time, and an increment can only ever ADD a newer row — so it
		// is left alone here and refreshed by the next resync.
	}

	/** Drop a key's cached total, e.g. after its limit is changed or cleared. */
	forget(apiKeyId: string) {
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
	_counter = null;
}
