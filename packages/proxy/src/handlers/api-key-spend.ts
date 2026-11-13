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
export const SPEND_RESERVATION_TTL_MS = 30 * 60 * 1000;
export const SPEND_SYNC_TIMEOUT_MS = 5_000;

class SpendCheckSupersededError extends Error {}

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
	/** Estimates for open requests, separate from completed spend. */
	reservedUsd?: number;
	/** The limit this was measured against. */
	limitUsd: number;
	/** Epoch ms when this window's spend next falls; null when unknown. */
	resetMs: number | null;
	/** Completed spend plus reservations has reached the limit (warnings use completed spend). */
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
			createdMs: number;
		}
	>();
	private readonly spendResetPoints = new Map<string, number>();
	private readonly reservationLocks = new Map<string, Promise<void>>();
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly syncTimeoutMs: number;
	constructor(
		private readonly dbOps: DatabaseOperations,
		options: { syncTimeoutMs?: number } = {},
	) {
		this.syncTimeoutMs = options.syncTimeoutMs ?? SPEND_SYNC_TIMEOUT_MS;
	}
	/** The underlying database work may finish later; callers never wait indefinitely. */
	private async bounded<T>(
		pending: Promise<T>,
		signal?: AbortSignal,
		timeoutMs: number | null = this.syncTimeoutMs,
	): Promise<T> {
		if (signal?.aborted) {
			// The operation was created before entering this helper.
			void pending.catch(() => {});
			throw signal.reason ?? new Error("Request aborted");
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const cancelled = new Promise<never>((_, reject) => {
			if (timeoutMs !== null)
				timer = setTimeout(
					() => reject(new Error("Spend sync deadline exceeded")),
					Math.max(0, timeoutMs),
				);
			if (signal) {
				onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		try {
			return await Promise.race([pending, cancelled]);
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}
	private expireReservations(nowMs: number): void {
		for (const [id, reservation] of this.reservations)
			if (nowMs - reservation.createdMs >= SPEND_RESERVATION_TTL_MS)
				this.reservations.delete(id);
	}
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
		this.expireReservations(now);
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
	async getLimitsForKey(
		apiKeyId: string,
		signal?: AbortSignal,
	): Promise<ApiKeyLimit[]> {
		this.lastAccess.set(apiKeyId, Date.now());
		const cached = this.keyLimits.get(apiKeyId);
		if (cached && Date.now() - cached.loadedMs < SPEND_RESYNC_TTL_MS)
			return cached.limits;
		const generation = this.limitGenerations.get(apiKeyId) ?? 0;
		let limits: ApiKeyLimit[];
		try {
			limits = await this.bounded(this.dbOps.getApiKeyLimits(apiKeyId), signal);
		} catch (error) {
			const stale = this.keyLimits.get(apiKeyId);
			if (!stale || signal?.aborted) throw error;
			log.warn(
				`Using cached spend limits for key ${apiKeyId} after refresh failed: ${String(error)}`,
			);
			return stale.limits;
		}
		if ((this.limitGenerations.get(apiKeyId) ?? 0) !== generation)
			return this.getLimitsForKey(apiKeyId, signal);
		this.keyLimits.set(apiKeyId, { loadedMs: Date.now(), limits });
		if (!this.refreshTimer) this.scheduleRefresh();
		return limits;
	}
	private identity(apiKeyId: string, limit: ApiKeyLimit): string {
		return JSON.stringify([apiKeyId, limit.scopeModel, limit.window]);
	}
	/**
	 * Reset completed spend and drop this key's in-flight reservations. Their
	 * final cost still counts when recorded at/after this boundary, even if the
	 * request started before it. Request history is never changed.
	 */
	applySpendReset(apiKeyId: string, timestamp: number): void {
		if ((this.spendResetPoints.get(apiKeyId) ?? 0) >= timestamp) return;
		this.spendResetPoints.set(apiKeyId, timestamp);
		this.forget(apiKeyId);
		for (const [id, reservation] of this.reservations)
			if (reservation.apiKeyId === apiKeyId) this.reservations.delete(id);
		const pending = this.pendingRecords.get(apiKeyId);
		if (pending)
			for (const [id, event] of pending)
				if (event.timestamp < timestamp) pending.delete(id);
	}

	private async loadSpendReset(apiKeyId: string): Promise<number> {
		if (typeof this.dbOps.getApiKey === "function") {
			const key = await this.dbOps.getApiKey(apiKeyId);
			const resetAt = key?.spendResetAt ?? 0;
			if (resetAt > (this.spendResetPoints.get(apiKeyId) ?? 0))
				this.applySpendReset(apiKeyId, resetAt);
		}
		return this.spendResetPoints.get(apiKeyId) ?? 0;
	}

	private async syncLimitKey(
		apiKeyId: string,
		limit: ApiKeyLimit,
		mode: ApiKeyLimitWindowMode,
		nowMs: number,
	): Promise<void> {
		const deadline = performance.now() + this.syncTimeoutMs;
		const resetAt =
			typeof this.dbOps.getApiKey === "function"
				? await this.bounded(
						this.loadSpendReset(apiKeyId),
						undefined,
						deadline - performance.now(),
					)
				: (this.spendResetPoints.get(apiKeyId) ?? 0);
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
						startMs: Math.max(
							apiKeyLimitWindowBounds(row.window, mode, nowMs).startMs,
							resetAt,
						),
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
			const reconciliation = await this.bounded(
				(async () =>
					typeof this.dbOps.getApiKeySpendReconciliation === "function"
						? await this.dbOps.getApiKeySpendReconciliation(
								apiKeyId,
								mode === "calendar" ? windows : [],
								mode === "rolling"
									? Math.min(...windows.map((window) => window.startMs))
									: null,
								Math.max(nowMs - SPEND_PENDING_TTL_MS, resetAt),
								nowMs,
							)
						: {
								calendar: null,
								events: await this.dbOps.getApiKeySpendEventsSince(
									apiKeyId,
									Math.min(...windows.map((window) => window.startMs)),
								),
							})(),
				undefined,
				deadline - performance.now(),
			);
			if (
				(this.limitGenerations.get(apiKeyId) ?? 0) !== generation ||
				limits.some(
					(row) =>
						this.limitSyncTokens.get(this.identity(apiKeyId, row)) !== token,
				)
			)
				throw new SpendCheckSupersededError(
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
					event.timestamp >= resetAt &&
					(!event.requestId || !seen.has(event.requestId)) &&
					nowMs - event.timestamp <= SPEND_PENDING_TTL_MS,
			);
			const merged = [...persisted, ...unpersisted].sort(
				(a, b) => a.timestamp - b.timestamp,
			);
			for (const row of limits) {
				const bounds = apiKeyLimitWindowBounds(row.window, mode, nowMs);
				const matches = (event: SpendEvent) =>
					event.timestamp >= resetAt &&
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
		_proposedCostUsd = 0,
		signal?: AbortSignal,
	): Promise<SpendSnapshot> {
		this.lastAccess.set(apiKeyId, Date.now());
		const identity = this.identity(apiKeyId, limit);
		const bounds = apiKeyLimitWindowBounds(limit.window, mode, nowMs);
		let generation = this.limitGenerations.get(apiKeyId) ?? 0;
		let entry = this.limitEntries.get(identity);
		if (
			reconcile ||
			!entry ||
			entry.lastSyncMs === 0 ||
			entry.mode !== mode ||
			(mode === "calendar" && entry.startMs !== bounds.startMs)
		) {
			try {
				await this.bounded(
					this.syncLimitKey(apiKeyId, limit, mode, nowMs),
					signal,
					null,
				);
			} catch (error) {
				const stale = this.limitEntries.get(identity);
				if (
					error instanceof SpendCheckSupersededError ||
					signal?.aborted ||
					!stale ||
					stale.mode !== mode ||
					stale.lastSyncMs === 0 ||
					(mode === "calendar" && stale.startMs !== bounds.startMs)
				)
					throw error;
				log.warn(
					`Using cached spend totals for key ${apiKeyId} after refresh failed: ${String(error)}`,
				);
			}
			generation = this.limitGenerations.get(apiKeyId) ?? 0;
			entry = this.limitEntries.get(identity);
		} else if (nowMs - entry.lastSyncMs >= SPEND_RESYNC_TTL_MS) {
			void this.syncLimitKey(apiKeyId, limit, mode, nowMs).catch((error) =>
				log.warn(
					`Spend counter resync failed for key ${apiKeyId}: ${String(error)}`,
				),
			);
		}
		if ((this.limitGenerations.get(apiKeyId) ?? 0) !== generation)
			throw new SpendCheckSupersededError(
				"Spend counter settings changed during check",
			);
		if (!entry)
			throw new SpendCheckSupersededError(
				"Spend counter failed to initialize after settings changed",
			);
		return this.snapshotFromEntry(
			apiKeyId,
			limit,
			mode,
			nowMs,
			entry,
			excludeReservationId,
		);
	}
	private snapshotFromEntry(
		apiKeyId: string,
		limit: ApiKeyLimit,
		mode: ApiKeyLimitWindowMode,
		nowMs: number,
		entry: {
			limit: ApiKeyLimit;
			spentUsd: number;
			cursor: number;
			events: SpendEvent[];
		},
		excludeReservationId?: string,
	): SpendSnapshot {
		const bounds = apiKeyLimitWindowBounds(limit.window, mode, nowMs);
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
		const spentUsd = Math.max(0, entry.spentUsd);
		let reservedUsd = 0;
		this.expireReservations(nowMs);
		for (const [id, reservation] of this.reservations)
			if (
				id !== excludeReservationId &&
				reservation.apiKeyId === apiKeyId &&
				this.matchesEventScope(reservation, limit.scopeModel)
			)
				reservedUsd += reservation.costUsd;
		const committedUsd =
			spentUsd + (limit.enforce === "warn" ? 0 : reservedUsd);
		let resetMs: number | null = bounds.endMs;
		if (mode === "rolling") {
			resetMs = null;
			let remaining = committedUsd;
			for (let i = entry.cursor; i < entry.events.length; i++) {
				const event = entry.events[i];
				remaining -= event.costUsd;
				resetMs = Math.min(
					nowMs + API_KEY_ROLLING_DURATION_MS[limit.window],
					event.timestamp + API_KEY_ROLLING_DURATION_MS[limit.window],
				);
				if (remaining < limit.limitUsd) break;
			}
			if (remaining >= limit.limitUsd) resetMs = null;
		}
		if (Math.abs(Date.now() - nowMs) < 1000 && !this.refreshTimer)
			this.scheduleRefresh();
		return {
			spentUsd,
			reservedUsd,
			limitUsd: limit.limitUsd,
			resetMs,
			exceeded: committedUsd >= limit.limitUsd,
		};
	}
	/** Read usable cached totals even when lock admission or a refresh failed. */
	getCachedChecks(
		apiKeyId: string,
		limits: ApiKeyLimit[],
		mode: ApiKeyLimitWindowMode,
		requestedModel: string | null,
		servedModel: string | null,
		nowMs = Date.now(),
		excludeReservationId?: string,
	): Array<{ limit: ApiKeyLimit; snapshot: SpendSnapshot }> {
		return limits.flatMap((limit) => {
			if (
				!this.matchesEventScope(
					{ requestedModel, model: servedModel },
					limit.scopeModel,
				)
			)
				return [];
			const entry = this.limitEntries.get(this.identity(apiKeyId, limit));
			if (
				!entry ||
				entry.lastSyncMs === 0 ||
				entry.mode !== mode ||
				(mode === "calendar" &&
					entry.startMs !==
						apiKeyLimitWindowBounds(limit.window, mode, nowMs).startMs)
			)
				return [];
			return [
				{
					limit,
					snapshot: this.snapshotFromEntry(
						apiKeyId,
						limit,
						mode,
						nowMs,
						entry,
						excludeReservationId,
					),
				},
			];
		});
	}
	/** Fail closed only for an applicable block limit without a usable total. */
	shouldFailClosed(
		apiKeyId: string,
		limits: ApiKeyLimit[],
		mode: ApiKeyLimitWindowMode,
		requestedModel: string | null,
		servedModel: string | null,
		nowMs = Date.now(),
	): boolean {
		return limits.some((limit) => {
			if (
				limit.enforce !== "block" ||
				!this.matchesEventScope(
					{ requestedModel, model: servedModel },
					limit.scopeModel,
				)
			)
				return false;
			const entry = this.limitEntries.get(this.identity(apiKeyId, limit));
			return (
				!entry ||
				entry.lastSyncMs === 0 ||
				entry.mode !== mode ||
				(mode === "calendar" &&
					entry.startMs !==
						apiKeyLimitWindowBounds(limit.window, mode, nowMs).startMs)
			);
		});
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
		signal?: AbortSignal,
	): Promise<Array<{ limit: ApiKeyLimit; snapshot: SpendSnapshot }>> {
		const previous = this.reservationLocks.get(apiKeyId) ?? Promise.resolve();
		let unlock!: () => void;
		const lock = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		// An aborted waiter must keep its place until its predecessor releases.
		const tail = previous.then(() => lock);
		this.reservationLocks.set(apiKeyId, tail);
		void tail.then(() => {
			if (this.reservationLocks.get(apiKeyId) === tail)
				this.reservationLocks.delete(apiKeyId);
		});
		try {
			await this.bounded(previous, signal);
			const reservation = {
				apiKeyId,
				model: servedModel,
				requestedModel,
				costUsd: Number.isFinite(estimatedUsd) ? Math.max(0, estimatedUsd) : 0,
				createdMs: nowMs,
			};
			for (let attempt = 0; attempt < 2; attempt++) {
				const generation = this.limitGenerations.get(apiKeyId) ?? 0;
				try {
					const snapshots: Array<{
						limit: ApiKeyLimit;
						snapshot: SpendSnapshot;
					}> = [];
					for (const limit of limits) {
						if (!this.matchesEventScope(reservation, limit.scopeModel))
							continue;
						try {
							const snapshot = await this.getLimitSnapshot(
								apiKeyId,
								limit,
								mode,
								nowMs,
								false,
								requestId,
								0,
								signal,
							);
							snapshots.push({ limit, snapshot });
						} catch (error) {
							if (
								error instanceof SpendCheckSupersededError ||
								limit.enforce === "block" ||
								signal?.aborted
							)
								throw error;
							log.warn(
								`Warn-only spend check unavailable for key ${apiKeyId}: ${String(error)}`,
							);
						}
					}
					if ((this.limitGenerations.get(apiKeyId) ?? 0) !== generation)
						throw new SpendCheckSupersededError(
							"Spend counter settings changed before reservation",
						);
					if (signal?.aborted)
						throw signal.reason ?? new Error("Request aborted");
					const blocked = snapshots.some(
						({ limit, snapshot }) =>
							limit.enforce === "block" && snapshot.exceeded,
					);
					if (blocked) this.reservations.delete(requestId);
					else {
						for (const { limit, snapshot } of snapshots)
							if (limit.enforce === "block")
								reservation.costUsd = Math.min(
									reservation.costUsd,
									Math.max(
										0,
										limit.limitUsd -
											snapshot.spentUsd -
											(snapshot.reservedUsd ?? 0),
									),
								);
						this.reservations.set(requestId, reservation);
						for (const { snapshot } of snapshots)
							snapshot.reservedUsd =
								(snapshot.reservedUsd ?? 0) + reservation.costUsd;
					}
					return snapshots;
				} catch (error) {
					if (!(error instanceof SpendCheckSupersededError)) throw error;
					if (attempt === 0) {
						if (typeof this.dbOps.getApiKeyLimits === "function")
							limits = await this.getLimitsForKey(apiKeyId, signal);
						continue;
					}
					// Repeated concurrent edits are not database unavailability.
					log.warn(
						`Spend check superseded again for key ${apiKeyId}; using next reconciliation`,
					);
					return [];
				}
			}
			return [];
		} finally {
			void previous.then(unlock);
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
		if (timestamp < (this.spendResetPoints.get(apiKeyId) ?? 0)) return;
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
			if (this.inflight.get(apiKeyId) === promise)
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
		const resetAt =
			typeof this.dbOps.getApiKey === "function"
				? await this.loadSpendReset(apiKeyId)
				: (this.spendResetPoints.get(apiKeyId) ?? 0);
		const generation = this.limitGenerations.get(apiKeyId) ?? 0;
		const windowStartMs = Math.max(
			computeSpendWindowStartMs(limit.limitWindow, nowMs),
			resetAt > 0 ? resetAt - 1 : 0,
		);
		const { totalUsd, oldestMs } = await this.dbOps.getApiKeySpendSince(
			apiKeyId,
			windowStartMs,
		);
		if ((this.limitGenerations.get(apiKeyId) ?? 0) !== generation)
			throw new Error("Spend counter reset during reconciliation");
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
