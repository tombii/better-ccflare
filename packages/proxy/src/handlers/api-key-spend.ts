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
 * Local completions are retained until acknowledged by request ID (up to ten
 * minutes), and open requests reserve an estimated cost. Separate instances
 * still converge at reconciliation; reservations are process-local.
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
export const SPEND_PENDING_TTL_MS = 10 * 60 * 1000;
export const SPEND_IDLE_TTL_MS = 60 * 60 * 1000;

interface SpendEvent {
	requestId?: string;
	timestamp: number;
	costUsd: number;
	model: string | null;
	requestedModel?: string | null;
}

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
			events: SpendEvent[];
		}
	>();
	private readonly limitInflight = new Map<string, Promise<void>>();
	private readonly limitGenerations = new Map<string, number>();
	private readonly limitSyncTokens = new Map<string, symbol>();
	/** Local completions remain authoritative until their request ID is persisted. */
	private readonly pendingRecords = new Map<string, Map<string, SpendEvent>>();
	private readonly keyLimits = new Map<
		string,
		{ loadedMs: number; limits: ApiKeyLimit[] }
	>();
	private readonly lastAccess = new Map<string, number>();
	private readonly reservations = new Map<
		string,
		{
			apiKeyId: string;
			model: string | null;
			requestedModel: string | null;
			costUsd: number;
		}
	>();
	private readonly reservationLocks = new Map<string, Promise<void>>();
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	constructor(private readonly dbOps: DatabaseOperations) {}
	dispose(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
	}
	get cachedLimitCount(): number {
		return this.limitEntries.size;
	}
	private scheduleRefresh(): void {
		this.dispose();
		if (!this.limitEntries.size && !this.keyLimits.size) return;
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
				void this.reconcileActiveKeys()
					.catch((error) =>
						log.warn(
							`Spend counter scheduled reconciliation failed: ${String(error)}`,
						),
					)
					.finally(() => this.scheduleRefresh());
			},
			Math.max(1, next - now),
		);
		this.refreshTimer.unref();
	}
	/** One refresh per active key, rather than one scan per scope/window row. */
	async reconcileActiveKeys(): Promise<void> {
		const now = Date.now();
		for (const [apiKeyId, lastAccess] of this.lastAccess)
			if (
				now - lastAccess > SPEND_IDLE_TTL_MS &&
				![...this.reservations.values()].some(
					(reservation) => reservation.apiKeyId === apiKeyId,
				)
			)
				this.evict(apiKeyId);
		const keys = new Map<
			string,
			{ limit: ApiKeyLimit; mode: ApiKeyLimitWindowMode }
		>();
		for (const entry of this.limitEntries.values())
			keys.set(entry.apiKeyId, entry);
		for (const [apiKeyId, entry] of keys) {
			try {
				if (typeof this.dbOps.getApiKey === "function") {
					const key = await this.dbOps.getApiKey(apiKeyId);
					if (!key?.isActive) {
						this.evict(apiKeyId);
						continue;
					}
				}
				await this.syncLimitKey(apiKeyId, entry.limit, entry.mode, now);
			} catch (error) {
				log.warn(
					`Spend counter resync failed for key ${apiKeyId}: ${String(error)}`,
				);
			}
		}
	}
	private evict(apiKeyId: string): void {
		this.forget(apiKeyId);
		this.pendingRecords.delete(apiKeyId);
		this.lastAccess.delete(apiKeyId);
		for (const [id, reservation] of this.reservations)
			if (reservation.apiKeyId === apiKeyId) this.reservations.delete(id);
	}
	async getLimitsForKey(apiKeyId: string): Promise<ApiKeyLimit[]> {
		this.lastAccess.set(apiKeyId, Date.now());
		const cached = this.keyLimits.get(apiKeyId);
		if (cached && Date.now() - cached.loadedMs < SPEND_RESYNC_TTL_MS)
			return cached.limits;
		const generation = this.limitGenerations.get(apiKeyId) ?? 0;
		const limits = await this.dbOps.getApiKeyLimits(apiKeyId);
		if ((this.limitGenerations.get(apiKeyId) ?? 0) !== generation)
			return this.getLimitsForKey(apiKeyId);
		this.keyLimits.set(apiKeyId, { loadedMs: Date.now(), limits });
		if (!this.refreshTimer) this.scheduleRefresh();
		return limits;
	}
	private identity(apiKeyId: string, limit: ApiKeyLimit): string {
		return JSON.stringify([apiKeyId, limit.scopeModel, limit.window]);
	}
	private async syncLimitKey(
		apiKeyId: string,
		limit: ApiKeyLimit,
		mode: ApiKeyLimitWindowMode,
		nowMs: number,
	): Promise<void> {
		const generation = this.limitGenerations.get(apiKeyId) ?? 0;
		const keyLimits =
			this.keyLimits.get(apiKeyId)?.limits ??
			[...this.limitEntries.values()]
				.filter((entry) => entry.apiKeyId === apiKeyId)
				.map((entry) => entry.limit);
		const limits = [
			...new Map(
				[...keyLimits, limit].map((row) => [this.identity(apiKeyId, row), row]),
			).values(),
		];
		const windows = [
			...new Map(
				limits.map((row) => [
					row.window,
					{
						window: row.window,
						...apiKeyLimitWindowBounds(row.window, mode, nowMs),
					},
				]),
			).values(),
		];
		const inflightIdentity = JSON.stringify([
			apiKeyId,
			generation,
			mode,
			limits.map((row) => this.identity(apiKeyId, row)),
			mode === "calendar" ? windows.map((window) => window.startMs) : null,
		]);
		const existing = this.limitInflight.get(inflightIdentity);
		if (existing) return existing;
		const token = Symbol();
		for (const row of limits)
			this.limitSyncTokens.set(this.identity(apiKeyId, row), token);
		const pending = (async () => {
			const local = this.pendingRecords.get(apiKeyId);
			if (local)
				for (const [id, event] of local)
					if (nowMs - event.timestamp > SPEND_PENDING_TTL_MS) local.delete(id);
			const reconciliation =
				typeof this.dbOps.getApiKeySpendReconciliation === "function"
					? await this.dbOps.getApiKeySpendReconciliation(
							apiKeyId,
							mode === "calendar" ? windows : [],
							mode === "rolling"
								? Math.min(...windows.map((window) => window.startMs))
								: null,
							nowMs - SPEND_PENDING_TTL_MS,
							nowMs,
						)
					: {
							calendar: null,
							events: await this.dbOps.getApiKeySpendEventsSince(
								apiKeyId,
								Math.min(...windows.map((window) => window.startMs)),
							),
						};
			if (
				(this.limitGenerations.get(apiKeyId) ?? 0) !== generation ||
				limits.some(
					(row) =>
						this.limitSyncTokens.get(this.identity(apiKeyId, row)) !== token,
				)
			)
				throw new Error(
					"Spend counter reconciliation superseded by updated settings",
				);
			const persisted = reconciliation.events;
			const seen = new Set(
				persisted.map((event) => event.requestId).filter(Boolean),
			);
			const outstanding = this.pendingRecords.get(apiKeyId);
			// Keep acknowledged IDs for the same short tail as well: an older
			// concurrent SQL snapshot may not have observed that commit yet.
			const unpersisted = [...(outstanding?.values() ?? [])].filter(
				(event) =>
					(!event.requestId || !seen.has(event.requestId)) &&
					nowMs - event.timestamp <= SPEND_PENDING_TTL_MS,
			);
			const merged = [...persisted, ...unpersisted].sort(
				(a, b) => a.timestamp - b.timestamp,
			);
			for (const row of limits) {
				const bounds = apiKeyLimitWindowBounds(row.window, mode, nowMs);
				const matches = (event: SpendEvent) =>
					(event.timestamp <= nowMs || unpersisted.includes(event)) &&
					(mode === "rolling"
						? event.timestamp > bounds.startMs
						: event.timestamp >= bounds.startMs &&
							event.timestamp < bounds.endMs) &&
					this.matchesEventScope(event, row.scopeModel);
				const events = merged.filter(matches);
				const aggregate = reconciliation.calendar?.find(
					(window) => window.window === row.window,
				);
				const spentUsd = aggregate
					? aggregate.totals.reduce(
							(sum, total) =>
								sum +
								(this.matchesEventScope(total, row.scopeModel)
									? total.totalUsd
									: 0),
							0,
						) +
						unpersisted
							.filter(matches)
							.reduce((sum, event) => sum + event.costUsd, 0)
					: events.reduce((sum, event) => sum + event.costUsd, 0);
				this.limitEntries.set(this.identity(apiKeyId, row), {
					apiKeyId,
					limit: row,
					mode,
					...bounds,
					lastSyncMs: nowMs,
					spentUsd,
					events: mode === "rolling" ? events : [],
					cursor: 0,
				});
			}
		})().finally(() => {
			this.limitInflight.delete(inflightIdentity);
		});
		this.limitInflight.set(inflightIdentity, pending);
		return pending;
	}
	async getLimitSnapshot(
		apiKeyId: string,
		limit: ApiKeyLimit,
		mode: ApiKeyLimitWindowMode,
		nowMs = Date.now(),
		reconcile = false,
		excludeReservationId?: string,
		proposedCostUsd = 0,
	): Promise<SpendSnapshot> {
		this.lastAccess.set(apiKeyId, Date.now());
		const identity = this.identity(apiKeyId, limit);
		const bounds = apiKeyLimitWindowBounds(limit.window, mode, nowMs);
		const generation = this.limitGenerations.get(apiKeyId) ?? 0;
		let entry = this.limitEntries.get(identity);
		if (
			reconcile ||
			!entry ||
			entry.lastSyncMs === 0 ||
			entry.mode !== mode ||
			(mode === "calendar" && entry.startMs !== bounds.startMs)
		) {
			await this.syncLimitKey(apiKeyId, limit, mode, nowMs);
			entry = this.limitEntries.get(identity);
		} else if (nowMs - entry.lastSyncMs >= SPEND_RESYNC_TTL_MS) {
			void this.syncLimitKey(apiKeyId, limit, mode, nowMs).catch((error) =>
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
		)
			entry.spentUsd -= entry.events[entry.cursor++].costUsd;
		if (entry.cursor > 1000 && entry.cursor > entry.events.length / 2) {
			entry.events = entry.events.slice(entry.cursor);
			entry.cursor = 0;
		}
		let spentUsd = Math.max(0, entry.spentUsd);
		for (const [id, reservation] of this.reservations)
			if (
				id !== excludeReservationId &&
				reservation.apiKeyId === apiKeyId &&
				this.matchesEventScope(reservation, limit.scopeModel)
			)
				spentUsd += reservation.costUsd;
		const alreadyExceeded = spentUsd >= limit.limitUsd;
		// A proposed request affects relief, but has no expiry before it completes.
		spentUsd += proposedCostUsd;
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
				if (
					proposedCostUsd > 0
						? remaining <= limit.limitUsd
						: remaining < limit.limitUsd
				)
					break;
			}
			if (
				proposedCostUsd > 0
					? remaining > limit.limitUsd
					: remaining >= limit.limitUsd
			)
				resetMs = null;
		}
		if (Math.abs(Date.now() - nowMs) < 1000 && !this.refreshTimer)
			this.scheduleRefresh();
		return {
			spentUsd,
			limitUsd: limit.limitUsd,
			resetMs,
			exceeded: alreadyExceeded || spentUsd > limit.limitUsd,
		};
	}
	/** Check and reserve under one per-key lock so concurrent checks cannot oversubscribe. */
	async checkAndReserve(
		apiKeyId: string,
		requestId: string,
		limits: ApiKeyLimit[],
		mode: ApiKeyLimitWindowMode,
		requestedModel: string | null,
		servedModel: string | null,
		estimatedUsd: number,
		nowMs = Date.now(),
	): Promise<Array<{ limit: ApiKeyLimit; snapshot: SpendSnapshot }>> {
		const previous = this.reservationLocks.get(apiKeyId) ?? Promise.resolve();
		let unlock!: () => void;
		const lock = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		this.reservationLocks.set(apiKeyId, lock);
		await previous;
		try {
			const reservation = {
				apiKeyId,
				model: servedModel,
				requestedModel,
				costUsd: Math.max(0, estimatedUsd),
			};
			const snapshots: Array<{ limit: ApiKeyLimit; snapshot: SpendSnapshot }> =
				[];
			for (const limit of limits) {
				if (!this.matchesEventScope(reservation, limit.scopeModel)) continue;
				const snapshot = await this.getLimitSnapshot(
					apiKeyId,
					limit,
					mode,
					nowMs,
					false,
					requestId,
					reservation.costUsd,
				);
				snapshots.push({ limit, snapshot });
			}
			if (
				!snapshots.some(
					({ limit, snapshot }) =>
						limit.enforce === "block" && snapshot.exceeded,
				)
			)
				this.reservations.set(requestId, reservation);
			else this.reservations.delete(requestId);
			return snapshots;
		} finally {
			unlock();
			if (this.reservationLocks.get(apiKeyId) === lock)
				this.reservationLocks.delete(apiKeyId);
		}
	}
	releaseReservation(requestId: string): void {
		this.reservations.delete(requestId);
	}
	private matchesEventScope(
		event: { model?: string | null; requestedModel?: string | null },
		scope: string | null,
	): boolean {
		return (
			this.matchesScope(event.model, scope) ||
			this.matchesScope(event.requestedModel, scope)
		);
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
		requestedModel: string | null = null,
	) {
		if (!apiKeyId) return;
		if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return;
		if (costUsd === 0) {
			this.releaseReservation(requestId);
			return;
		}
		this.releaseReservation(requestId);
		const recorded = {
			requestId,
			timestamp,
			costUsd,
			model: model ?? null,
			requestedModel,
		};
		if (this.lastAccess.has(apiKeyId) || this.entries.has(apiKeyId)) {
			let pending = this.pendingRecords.get(apiKeyId);
			if (!pending) {
				pending = new Map();
				this.pendingRecords.set(apiKeyId, pending);
			}
			if (pending.has(requestId)) return;
			pending.set(requestId, recorded);
			this.lastAccess.set(apiKeyId, Date.now());
		}

		for (const entry of this.limitEntries.values()) {
			if (
				entry.apiKeyId !== apiKeyId ||
				!this.matchesEventScope(recorded, entry.limit.scopeModel)
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
			if (entry.mode === "calendar") {
				entry.spentUsd += costUsd;
				continue;
			}
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
