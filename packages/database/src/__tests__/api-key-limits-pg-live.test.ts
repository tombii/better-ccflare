/**
 * Live PostgreSQL parity for the API-key limits SQL in PR #556.
 * Run with DATABASE_URL set to a disposable PostgreSQL database; plain bun test
 * skips the suite. Like search-provider-pg-live.test.ts and pg-live-queries.test.ts,
 * all migrations and fixtures live in a throwaway schema on one pinned connection.
 */
import "@better-ccflare/core"; // Must precede types: the existing core/types cycle needs this order.
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type {
	ApiKeySpendLimit,
	ApiKeyUsageResponse,
} from "@better-ccflare/types";
import type { APIContext } from "../../../http-api/src/types";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import type { DatabaseOperations } from "../database-operations";

const livePgAvailable = Boolean(process.env.DATABASE_URL);
const SCHEMA = `ccflare_keylimits_${process.pid.toString(36)}_${Date.now().toString(36)}`;
// Shared with api-key-spend-reconciliation.test.ts; well above a signed INT32.
const NOW = Date.parse("2026-11-13T13:00:02Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!livePgAvailable)("API-key limits (live PostgreSQL)", () => {
	let db: DatabaseOperations;
	let adapter: BunSqlAdapter;
	const liveIt = (name: string, fn: () => Promise<void>) =>
		it(name, fn, 30_000);

	beforeAll(async () => {
		// The same pool/search_path isolation as the existing live-PG harnesses.
		process.env.BETTER_CCFLARE_DB_POOL_MAX = "1";
		process.env.BETTER_CCFLARE_DB_IDLE_TIMEOUT = "0";
		delete process.env.BETTER_CCFLARE_DB_PG_PREPARE;
		const { DatabaseOperations: DbOps } = await import(
			"../database-operations"
		);
		db = new DbOps();
		adapter = db.getAdapter();
		if (adapter.isSQLite) {
			throw new Error(
				"DATABASE_URL is set but the adapter selected SQLite — refusing to run a PostgreSQL harness against SQLite.",
			);
		}
		await adapter.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
		await adapter.unsafe(`SET search_path TO "${SCHEMA}"`);
		await adapter.unsafe("SET lock_timeout = '10s'");
		await adapter.unsafe("SET statement_timeout = '60s'");
		const pinned = await adapter.get<{ s: string | null }>(
			"SELECT current_schema() AS s",
		);
		if (pinned?.s !== SCHEMA) {
			await adapter.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
			await db.close();
			throw new Error(
				`search_path pin failed: expected ${SCHEMA}, got ${pinned?.s}. ` +
					"Refusing to run against an unisolated schema.",
			);
		}
		// Real boot path: ensureSchemaPg + runMigrationsPg in the pinned schema.
		await db.initializeAsync();
	}, 60_000);

	afterAll(async () => {
		try {
			await adapter?.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
		} finally {
			await db?.close();
		}
	});

	beforeEach(async () => {
		const pinned = await adapter.get<{ s: string | null }>(
			"SELECT current_schema() AS s",
		);
		expect(pinned?.s).toBe(SCHEMA);
		await adapter.unsafe(
			"TRUNCATE TABLE requests, alerts, api_keys, combos, accounts RESTART IDENTITY CASCADE",
		);
	});

	async function key(id = "key", spendLimit?: ApiKeySpendLimit) {
		await db.createApiKey({
			id,
			name: id,
			hashedKey: `hash-${id}`,
			prefixLast8: "abcdefgh",
			createdAt: NOW,
			isActive: true,
			spendLimit,
		});
	}

	async function event(
		id: string,
		timestamp: number,
		duration: number,
		cost: number | null,
		model: string | null = "opus",
		requested: string | null = "sonnet",
		options: {
			keyId?: string;
			originalModel?: string;
			spendRecordedAt?: number;
			billingType?: string | null;
			accountId?: string;
			success?: boolean;
		} = {},
	) {
		await adapter.run(
			`INSERT INTO requests
			 (id, timestamp, response_time_ms, method, path, api_key_id, cost_usd,
			 model, limit_model, original_model, spend_recorded_at, billing_type,
			 account_used, success, input_tokens, output_tokens, total_tokens)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				timestamp,
				duration,
				"POST",
				"/v1/messages",
				options.keyId ?? "key",
				cost,
				model,
				requested,
				options.originalModel ?? null,
				options.spendRecordedAt ?? null,
				options.billingType === undefined ? "api" : options.billingType,
				options.accountId ?? null,
				options.success ?? true,
				10,
				5,
				15,
			],
		);
	}

	liveIt(
		"migrates BIGINT accounting timestamps and scoped limit indexes in the pinned schema",
		async () => {
			const columns = await adapter.query<{
				table_name: string;
				column_name: string;
				data_type: string;
			}>(
				`SELECT table_name, column_name, data_type FROM information_schema.columns
			 WHERE table_schema = ? AND ((table_name = 'requests' AND column_name IN ('timestamp', 'spend_recorded_at'))
			 OR (table_name = 'api_keys' AND column_name = 'spend_reset_at'))
			 ORDER BY table_name, column_name`,
				[SCHEMA],
			);
			expect(columns).toEqual([
				{
					table_name: "api_keys",
					column_name: "spend_reset_at",
					data_type: "bigint",
				},
				{
					table_name: "requests",
					column_name: "spend_recorded_at",
					data_type: "bigint",
				},
				{
					table_name: "requests",
					column_name: "timestamp",
					data_type: "bigint",
				},
			]);
			const indexes = await adapter.query<{ indexname: string }>(
				"SELECT indexname FROM pg_indexes WHERE schemaname = ? AND tablename = 'api_key_limits'",
				[SCHEMA],
			);
			expect(indexes.map((row) => row.indexname)).toContain(
				"idx_api_key_limits_scope",
			);
		},
	);

	liveIt(
		"creates legacy key metadata and its enforceable limit in one batch",
		async () => {
			await key("key", {
				limitUsd: 5,
				limitWindow: "rolling_7d",
				limitEnforce: "block",
			});
			expect(await db.getApiKey("key")).toMatchObject({
				limitUsd: 5,
				limitWindow: "rolling_7d",
				limitWindowMode: "rolling",
				createdAt: NOW,
			});
			expect(await db.getApiKeyLimits("key")).toMatchObject([
				{
					apiKeyId: "key",
					scopeModel: null,
					window: "week",
					limitUsd: 5,
					enforce: "block",
					createdAt: NOW,
					updatedAt: NOW,
				},
			]);
			expect(
				(await db.listApiKeysWithSpendLimits()).map((row) => row.id),
			).toEqual(["key"]);
			await db.disableApiKey("key");
			expect(await db.listApiKeysWithSpendLimits()).toEqual([]);
		},
	);

	liveIt(
		"rolls back the new key when its limit row violates the real PostgreSQL CHECK",
		async () => {
			// api_keys accepts zero; api_key_limits rejects it after the key INSERT.
			await expect(
				key("failed", {
					limitUsd: 0,
					limitWindow: "rolling_7d",
					limitEnforce: "block",
				}),
			).rejects.toThrow();
			expect(await db.getApiKey("failed")).toBeNull();
			expect(await db.getApiKeyLimits("failed")).toEqual([]);
			expect(await db.countAllApiKeys()).toBe(0);
		},
	);

	liveIt(
		"replaces limits atomically and maintains the legacy month shim without losing scoped rows",
		async () => {
			await key();
			expect((await db.getApiKey("key"))?.limitWindowMode).toBe("calendar");
			expect(
				await db.replaceApiKeyLimits(
					"key",
					[
						{
							scopeModel: "opus",
							window: "day",
							limitUsd: 2,
							enforce: "block",
						},
					],
					"calendar",
				),
			).toBe(true);
			const before = await db.getApiKeyLimits("key");
			// Duplicate NULL scopes exercise the expression unique index and rollback
			// both the DELETE and the earlier mode UPDATE, as in the SQLite fixture.
			await expect(
				db.replaceApiKeyLimits(
					"key",
					[
						{ scopeModel: null, window: "hour", limitUsd: 1, enforce: "block" },
						{ scopeModel: null, window: "hour", limitUsd: 2, enforce: "warn" },
					],
					"rolling",
				),
			).rejects.toThrow();
			expect((await db.getApiKey("key"))?.limitWindowMode).toBe("calendar");
			expect(await db.getApiKeyLimits("key")).toEqual(before);
			expect(
				await db.updateApiKeySpendLimit("key", {
					limitUsd: 12,
					limitWindow: "calendar_month",
					limitEnforce: "warn",
				}),
			).toBe(true);
			expect(
				(await db.getApiKeyLimits("key")).map((row) => row.window).sort(),
			).toEqual(["day", "month"]);
			expect(await db.getApiKey("key")).toMatchObject({
				limitUsd: 12,
				limitWindow: "calendar_month",
				limitEnforce: "warn",
			});
			const month = (await db.getApiKeyLimits("key")).find(
				(row) => row.window === "month",
			);
			await db.updateApiKeySpendLimit("key", {
				limitUsd: 8,
				limitWindow: "calendar_month",
				limitEnforce: "block",
			});
			expect(
				(await db.getApiKeyLimits("key")).find((row) => row.window === "month"),
			).toMatchObject({
				id: month?.id,
				createdAt: month?.createdAt,
				limitUsd: 8,
			});
			const beforeFailedUpdate = await db.getApiKeyLimits("key");
			await expect(
				db.updateApiKeySpendLimit("key", {
					limitUsd: 0,
					limitWindow: "calendar_month",
					limitEnforce: "warn",
				}),
			).rejects.toThrow();
			expect(await db.getApiKeyLimits("key")).toEqual(beforeFailedUpdate);
			expect(await db.getApiKey("key")).toMatchObject({
				limitUsd: 8,
				limitEnforce: "block",
			});
			await expect(
				db.updateApiKeySpendLimit("key", {
					limitUsd: 4,
					limitWindow: "rolling_7d",
					limitEnforce: "block",
				}),
			).rejects.toThrow("window mode");
			expect(await db.updateApiKeySpendLimit("key", null)).toBe(true);
			expect(
				(await db.getApiKeyLimits("key")).map((row) => row.window),
			).toEqual(["day"]);
			expect(await db.getApiKey("key")).toMatchObject({
				limitUsd: null,
				limitWindow: null,
				limitEnforce: null,
				limitWindowMode: "calendar",
			});
			expect(await db.replaceApiKeyLimits("missing", [], "rolling")).toBe(
				false,
			);
			expect(await db.updateApiKeySpendLimit("missing", null)).toBe(false);
			expect(
				await db.replaceApiKeyLimits(
					"key",
					[
						{ scopeModel: "opus", window: "day", limitUsd: 3, enforce: "warn" },
						{ scopeModel: null, window: "hour", limitUsd: 4, enforce: "block" },
					],
					"rolling",
				),
			).toBe(true);
			const replaced = await db.getApiKeyLimits("key");
			expect(replaced).toHaveLength(2);
			expect(replaced.find((row) => row.window === "day")).toMatchObject({
				id: before[0].id,
				createdAt: before[0].createdAt,
				scopeModel: "opus",
				limitUsd: 3,
				enforce: "warn",
			});
			expect(replaced.find((row) => row.window === "hour")).toMatchObject({
				scopeModel: null,
				limitUsd: 4,
				enforce: "block",
			});
			expect((await db.getApiKey("key"))?.limitWindowMode).toBe("rolling");
			expect(await db.replaceApiKeyLimits("key", [], "calendar")).toBe(true);
			expect(await db.getApiKeyLimits("key")).toEqual([]);
			expect((await db.getApiKey("key"))?.limitWindowMode).toBe("calendar");
			await db.replaceApiKeyLimits(
				"key",
				[{ scopeModel: null, window: "hour", limitUsd: 4, enforce: "block" }],
				"calendar",
			);
			await db.deleteApiKey("key");
			expect(await db.getApiKeyLimits("key")).toEqual([]);
		},
	);

	liveIt(
		"resetSpend reports applied, stale, equal, and missing resets and preserves other alert cooldowns",
		async () => {
			await key("key", {
				limitUsd: 5,
				limitWindow: "rolling_7d",
				limitEnforce: "block",
			});
			await event("history", NOW - 1000, 0, 2);
			expect(await db.resetApiKeySpend("key", NOW, "new")).toBe(true);
			for (const [id, type] of [
				["api_key_spend_limit:key:hour", "api_key_spend_limit"],
				["api_key_spend_limit:other:hour", "api_key_spend_limit"],
				["api_key_spend_limit:key:unrelated", "daily_spend"],
			]) {
				await adapter.run(
					"INSERT INTO alerts (id, type, severity, title, message, timestamp) VALUES (?, ?, 'warning', 'limit', 'limit', ?)",
					[id, type, NOW],
				);
			}
			expect(await db.resetApiKeySpend("key", NOW - 1, "old")).toBe(false);
			expect(await db.resetApiKeySpend("missing", NOW + 1, "none")).toBe(false);
			expect(await adapter.query("SELECT id FROM alerts")).toHaveLength(3);
			expect(await db.getApiKey("key")).toMatchObject({
				spendResetAt: NOW,
				spendResetBy: "new",
			});
			// Equal timestamps are accepted by the SQL <= guard and clear cooldowns.
			expect(await db.resetApiKeySpend("key", NOW, "equal")).toBe(true);
			expect(
				(
					await adapter.query<{ id: string }>(
						"SELECT id FROM alerts ORDER BY id",
					)
				).map((row) => row.id),
			).toEqual([
				"api_key_spend_limit:key:unrelated",
				"api_key_spend_limit:other:hour",
			]);
			expect(await db.resetApiKeySpend("key", NOW + 1, "newer")).toBe(true);
			expect((await db.getApiKey("key"))?.spendResetBy).toBe("newer");
			expect(await db.getApiKeyLimits("key")).toHaveLength(1);
			expect(await adapter.query("SELECT id FROM requests")).toHaveLength(1);
		},
	);

	liveIt(
		"returns calendar totals with a short event tail and legacy rolling full events",
		async () => {
			await event("old", NOW - 2 * HOUR, 0, 3);
			await event("tail", NOW - 1000, 0, 2);
			await event("future", NOW + 1000, 0, 99);
			const calendar = await db.getApiKeySpendReconciliation(
				"key",
				[
					{
						window: "day",
						startMs: Date.parse("2026-11-13T00:00:00Z"),
						endMs: Date.parse("2026-11-14T00:00:00Z"),
					},
				],
				null,
				NOW - 600_000,
				NOW,
			);
			expect(calendar.calendar[0].totals).toEqual([
				{ model: "opus", requestedModel: "sonnet", totalUsd: 5 },
			]);
			expect(calendar.events.map((row) => row.requestId)).toEqual(["tail"]);
			expect(calendar.calendar[0].buckets).toBeUndefined();
			const rolling = await db.getApiKeySpendReconciliation(
				"key",
				[],
				NOW - DAY,
				NOW - 600_000,
				NOW,
			);
			expect(rolling.events.map((row) => row.requestId).sort()).toEqual([
				"old",
				"tail",
			]);
		},
	);

	liveIt(
		"bounds request starts while attributing completion and recorded cost times precisely",
		async () => {
			const since = NOW - 60_000;
			await event("completed-in-window", since - 1000, 2000, 2);
			await event("completed-before-window", since - 2000, 1000, 4);
			await event("beyond-completion-lag", since - DAY - 1, DAY + 2, 16);
			await event("future-start", NOW + 1, 0, 32);
			const result = await db.getApiKeySpendReconciliation(
				"key",
				[{ window: "hour", startMs: since, endMs: NOW + 60_000 }],
				null,
				since,
				NOW,
			);
			expect(result.calendar[0].totals).toEqual([
				{ model: "opus", requestedModel: "sonnet", totalUsd: 2 },
			]);
			expect(result.events).toEqual([
				{
					requestId: "completed-in-window",
					timestamp: since + 1000,
					costUsd: 2,
					model: "opus",
					requestedModel: "sonnet",
				},
			]);
			expect(
				(await db.getApiKeySpendEventsSince("key", since, NOW)).map(
					(row) => row.requestId,
				),
			).toEqual(["completed-in-window"]);
			expect(await db.getApiKeySpendSince("key", since, NOW)).toEqual({
				totalUsd: 2,
				oldestMs: since + 1000,
			});
			// Recorded cost time supersedes start+latency, and requested model falls
			// back to original_model only when limit_model is absent.
			await event("late-pricing", since - 5000, 0, 8, "mapped", null, {
				spendRecordedAt: NOW,
				originalModel: "original",
			});
			const late = await db.getApiKeySpendEventsSince("key", since, NOW);
			expect(late[1]).toEqual({
				requestId: "late-pricing",
				timestamp: NOW,
				costUsd: 8,
				model: "mapped",
				requestedModel: "original",
			});
			expect(await db.getApiKeySpendSince("missing", since, NOW)).toEqual({
				totalUsd: 0,
				oldestMs: null,
			});
		},
	);

	liveIt(
		"keeps rolling exact edges and acknowledgements disjoint from shared hourly buckets",
		async () => {
			const monthStart = NOW - 30 * DAY;
			const dayStart = NOW - DAY;
			await event("month-edge", monthStart + 1000, 0, 1);
			await event("day-edge", dayStart + 1000, 0, 2);
			await event("middle-a", NOW - HOUR, 0, 4, "mapped", "opus");
			await event("middle-b", NOW - HOUR + 1000, 0, 8, "mapped", "opus");
			await event("ack", NOW - 1000, 0, 16);
			await event("outside", monthStart, 0, 99);
			const result = await db.getApiKeySpendReconciliation(
				"key",
				[
					{ window: "month", startMs: monthStart, endMs: NOW + 30 * DAY },
					{ window: "day", startMs: dayStart, endMs: NOW + DAY },
				],
				monthStart,
				NOW - 600_000,
				NOW,
				120_000,
			);
			expect(result.events.map((row) => row.requestId).sort()).toEqual([
				"ack",
				"day-edge",
				"month-edge",
			]);
			expect(
				result.calendar.map(({ totals }) =>
					totals.reduce((sum, row) => sum + row.totalUsd, 0),
				),
			).toEqual([31, 30]);
			expect(
				result.calendar[0].totals.find((row) => row.model === "opus")
					?.firstTimestampMs,
			).toBe(monthStart + 1000);
			expect(
				result.calendar[1].totals.find((row) => row.model === "opus")
					?.firstTimestampMs,
			).toBe(dayStart + 1000);
			for (const window of result.calendar) {
				expect(window.buckets).toEqual([
					{
						timestamp: Math.floor(NOW / HOUR) * HOUR,
						costUsd: 12,
						model: "mapped",
						requestedModel: "opus",
					},
				]);
			}
		},
	);

	liveIt(
		"rounds a settled hour upward even at its exact start and final millisecond, never early",
		async () => {
			const hourStart = Math.floor(NOW / HOUR) * HOUR - 2 * HOUR;
			for (let index = 0; index < 100; index++) {
				await event(`settled-${index}`, hourStart + index, 0, 1);
			}
			await event("hour-end", hourStart + HOUR - 1, 0, 4);
			await event("next-hour", hourStart + HOUR, 0, 8);
			const start = NOW - 30 * DAY;
			const result = await db.getApiKeySpendReconciliation(
				"key",
				[{ window: "month", startMs: start, endMs: NOW + 30 * DAY }],
				start,
				NOW - 600_000,
				NOW,
				120_000,
			);
			expect(result.events).toEqual([]);
			expect(result.calendar[0].totals[0]).toMatchObject({
				totalUsd: 112,
				firstTimestampMs: hourStart,
			});
			expect(
				result.calendar[0].buckets?.sort((a, b) => a.timestamp - b.timestamp),
			).toEqual([
				{
					timestamp: hourStart + HOUR,
					costUsd: 104,
					model: "opus",
					requestedModel: "sonnet",
				},
				{
					timestamp: hourStart + 2 * HOUR,
					costUsd: 8,
					model: "opus",
					requestedModel: "sonnet",
				},
			]);
			for (const bucket of result.calendar[0].buckets ?? []) {
				expect(typeof bucket.timestamp).toBe("number");
				expect(bucket.timestamp).toBeGreaterThan(hourStart);
				expect(bucket.timestamp % HOUR).toBe(0);
			}
		},
	);

	liveIt(
		"honors inclusive calendar, exclusive rolling, exact expiry-tail, and acknowledgement boundaries",
		async () => {
			const start = NOW - DAY;
			const tail = NOW - 600_000;
			await event("at-start", start, 0, 1);
			await event("at-expiry-end", start + 120_000, 0, 2);
			await event("after-expiry-end", start + 120_001, 0, 4);
			await event("at-tail", tail, 0, 8);
			await event("at-now", NOW, 0, 16);
			await event("future-completion", NOW - 1, 2, 32);
			await event("other-key", NOW - 1, 0, 64, "opus", "sonnet", {
				keyId: "other",
			});
			await event("free", NOW - 1, 0, 0);
			await event("unpriced", NOW - 1, 0, null);
			const windows = [{ window: "day", startMs: start, endMs: NOW }];
			const rolling = await db.getApiKeySpendReconciliation(
				"key",
				windows,
				start,
				tail,
				NOW,
				120_000,
			);
			expect(rolling.calendar[0].totals[0].totalUsd).toBe(14);
			expect(rolling.events.map((row) => row.requestId).sort()).toEqual([
				"at-expiry-end",
				"at-now",
				"at-tail",
			]);
			expect(
				rolling.calendar[0].buckets?.reduce((sum, row) => sum + row.costUsd, 0),
			).toBe(4);
			const calendar = await db.getApiKeySpendReconciliation(
				"key",
				windows,
				null,
				tail,
				NOW,
			);
			expect(calendar.calendar[0].totals[0].totalUsd).toBe(15);
		},
	);

	liveIt(
		"applies spend_reset_at inclusively to totals, exact events, buckets, and spend helpers",
		async () => {
			await key();
			const reset = Math.floor(NOW / HOUR) * HOUR - 2 * HOUR + 1000;
			await db.resetApiKeySpend("key", reset, "admin");
			await event("before-reset", reset - 1, 0, 99);
			await event("at-reset", reset, 0, 3);
			await event("boundary", NOW - 1000, 0, 2);
			const start = NOW - DAY;
			const result = await db.getApiKeySpendReconciliation(
				"key",
				[{ window: "day", startMs: start, endMs: NOW + DAY }],
				start,
				NOW - 600_000,
				NOW,
				120_000,
			);
			expect(result.calendar[0].totals).toEqual([
				{
					model: "opus",
					requestedModel: "sonnet",
					totalUsd: 5,
					firstTimestampMs: reset,
				},
			]);
			expect(result.events.map((row) => row.requestId)).toEqual(["boundary"]);
			expect(result.calendar[0].buckets).toEqual([
				{
					timestamp: (Math.floor(reset / HOUR) + 1) * HOUR,
					costUsd: 3,
					model: "opus",
					requestedModel: "sonnet",
				},
			]);
			expect(
				(await db.getApiKeySpendEventsSince("key", start, NOW)).map(
					(row) => row.requestId,
				),
			).toEqual(["at-reset", "boundary"]);
			expect(await db.getApiKeySpendSince("key", start, NOW)).toEqual({
				totalUsd: 5,
				oldestMs: reset,
			});
			const calendar = await db.getApiKeySpendReconciliation(
				"key",
				[{ window: "day", startMs: start, endMs: NOW + DAY }],
				null,
				NOW - 600_000,
				NOW,
			);
			expect(calendar.calendar[0].totals[0].totalUsd).toBe(5);
		},
	);

	liveIt(
		"preserves requested-model and recorded-time metadata through the changed request upsert",
		async () => {
			const { RequestRepository } = await import(
				"../repositories/request.repository"
			);
			const repository = new RequestRepository(adapter);
			const request = {
				id: "combo-budget",
				timestamp: NOW - 1000,
				method: "POST",
				path: "/v1/messages",
				accountUsed: null,
				statusCode: 200,
				success: true,
				errorMessage: null,
				responseTime: 50,
				failoverAttempts: 0,
				apiKeyId: "key",
				usage: { model: "gpt-sol", costUsd: 2 },
			};
			await repository.save({
				...request,
				limitModel: "claude-opus-4-6",
				spendRecordedAt: NOW,
			});
			await repository.save(request);
			expect(await db.getApiKeySpendEventsSince("key", NOW, NOW)).toEqual([
				{
					requestId: "combo-budget",
					timestamp: NOW,
					costUsd: 2,
					model: "gpt-sol",
					requestedModel: "claude-opus-4-6",
				},
			]);
		},
	);

	liveIt(
		"combo deletion cleans current routing maps, nulls empty maps, and skips malformed/non-object values",
		async () => {
			const gone = await db.createCombo("gone");
			const kept = await db.createCombo("kept");
			await key();
			await db.updateApiKeyRouting("key", { opus: gone.id, sonnet: kept.id });
			await key("empty");
			await db.updateApiKeyRouting("empty", { opus: gone.id });
			const invalid = [
				`{"opus":${JSON.stringify(gone.id)}`,
				JSON.stringify([gone.id]),
				JSON.stringify(gone.id),
				"null",
			];
			for (const [index, value] of invalid.entries()) {
				await key(`invalid-${index}`);
				await adapter.run(
					"UPDATE api_keys SET family_combo_overrides = ? WHERE id = ?",
					[value, `invalid-${index}`],
				);
			}
			await db.deleteCombo(gone.id);
			expect((await db.getApiKey("key"))?.familyComboOverrides).toEqual({
				sonnet: kept.id,
			});
			expect((await db.getApiKey("empty"))?.familyComboOverrides).toBeNull();
			for (const [index, value] of invalid.entries()) {
				expect(
					(
						await adapter.get<{ family_combo_overrides: string }>(
							"SELECT family_combo_overrides FROM api_keys WHERE id = ?",
							[`invalid-${index}`],
						)
					)?.family_combo_overrides,
				).toBe(value);
			}
			expect((await db.listCombos()).map((row) => row.id)).toEqual([kept.id]);
		},
	);

	liveIt("rolls routing cleanup back if the combo DELETE fails", async () => {
		const gone = await db.createCombo("gone");
		await key();
		await db.updateApiKeyRouting("key", { opus: gone.id });
		await adapter.unsafe(
			`CREATE FUNCTION fail_combo_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delete failed'; END; $$`,
		);
		await adapter.unsafe(
			"CREATE TRIGGER fail_combo BEFORE DELETE ON combos FOR EACH ROW EXECUTE FUNCTION fail_combo_delete()",
		);
		try {
			await expect(db.deleteCombo(gone.id)).rejects.toThrow("delete failed");
			expect((await db.getApiKey("key"))?.familyComboOverrides).toEqual({
				opus: gone.id,
			});
			expect((await db.listCombos()).map((row) => row.id)).toEqual([gone.id]);
		} finally {
			await adapter.unsafe("DROP TRIGGER fail_combo ON combos");
			await adapter.unsafe("DROP FUNCTION fail_combo_delete()");
		}
		await db.deleteCombo(gone.id);
		expect((await db.getApiKey("key"))?.familyComboOverrides).toBeNull();
	});

	liveIt(
		"executes usage-page totals, model/account grouping, plan denominator, and BIGINT time-series queries",
		async () => {
			const { createApiKeyUsageHandler } = await import(
				"../../../http-api/src/handlers/api-key-usage"
			);
			const { calendarMonthFraction } = await import(
				"../../../http-api/src/services/api-key-usage-range"
			);
			for (const [id, name, monthly] of [
				["acct-1", "primary", 300],
				["acct-2", "secondary", null],
			] as const) {
				await adapter.run(
					"INSERT INTO accounts (id, name, provider, created_at, plan_monthly_usd) VALUES (?, ?, 'openai-compatible', ?, ?)",
					[id, name, NOW, monthly],
				);
			}
			await key();
			await key("other");
			await event("u-1", NOW - HOUR, 0, 1.5, "claude-sonnet-4", null, {
				accountId: "acct-1",
				billingType: "plan",
			});
			await event("u-2", NOW - 2 * HOUR, 0, 0.25, null, null, {
				accountId: "acct-1",
				billingType: null,
				success: false,
			});
			await event("u-3", NOW - 3 * HOUR, 0, 0.75, "claude-sonnet-4", null, {
				accountId: "acct-2",
				billingType: "plan",
			});
			await event("u-4", NOW - HOUR, 0, 4.5, "claude-sonnet-4", null, {
				keyId: "other",
				accountId: "acct-1",
				billingType: "plan",
			});
			await adapter.run(
				"UPDATE requests SET failover_attempts = ? WHERE id = ?",
				[2, "u-1"],
			);
			await adapter.run(
				"UPDATE requests SET failover_attempts = ? WHERE id = ?",
				[99, "u-2"],
			);
			// Half-open range exclusions, including the plan denominator query.
			await event("before-range", NOW - DAY - 1, 0, 64, null, null, {
				accountId: "acct-1",
				billingType: "plan",
			});
			await event("at-end", NOW, 0, 128, null, null, {
				accountId: "acct-1",
				billingType: "plan",
			});
			const response = await createApiKeyUsageHandler({
				dbOps: db,
			} as APIContext)(
				"key",
				new URLSearchParams({
					range: "custom",
					from: new Date(NOW - DAY).toISOString(),
					to: new Date(NOW).toISOString(),
				}),
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as ApiKeyUsageResponse;
			expect(body.requests).toBe(3);
			expect(body.successfulRequests).toBe(2);
			expect(body.failedAttempts).toBe(1);
			expect(body.failoverAttempts).toBe(2);
			expect(body.recoveredRequests).toBe(1);
			expect(body.tokens).toEqual({
				inputTokens: 30,
				outputTokens: 15,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalTokens: 45,
			});
			expect(body.apiCostUsd).toBe(0.25);
			expect(body.planValueUsd).toBe(2.25);
			expect(body.totalCostUsd).toBe(2.5);
			expect(body.models).toEqual([
				{
					model: "claude-sonnet-4",
					requests: 2,
					costUsd: 2.25,
					totalTokens: 30,
				},
				{ model: null, requests: 1, costUsd: 0.25, totalTokens: 15 },
			]);
			expect(body.accounts).toEqual([
				{
					accountId: "acct-1",
					accountName: "primary",
					requests: 2,
					failedAttempts: 1,
					costUsd: 1.75,
				},
				{
					accountId: "acct-2",
					accountName: "secondary",
					requests: 1,
					failedAttempts: 0,
					costUsd: 0.75,
				},
			]);
			expect(
				body.planCost.accounts.find((row) => row.accountId === "acct-1")?.share,
			).toBe(0.25);
			expect(body.planCost.planCostUsd).toBeCloseTo(
				75 * calendarMonthFraction(NOW - DAY, NOW),
				4,
			);
			expect(body.planCost.unpricedAccountIds).toEqual(["acct-2"]);
			expect(body.efficiencyStatus).toBe("partial");
			expect(body.series).toEqual([
				{
					ts: Math.floor((NOW - 3 * HOUR) / HOUR) * HOUR,
					requests: 1,
					apiCostUsd: 0,
					planValueUsd: 0.75,
				},
				{
					ts: Math.floor((NOW - 2 * HOUR) / HOUR) * HOUR,
					requests: 1,
					apiCostUsd: 0.25,
					planValueUsd: 0,
				},
				{
					ts: Math.floor((NOW - HOUR) / HOUR) * HOUR,
					requests: 1,
					apiCostUsd: 0,
					planValueUsd: 1.5,
				},
			]);
		},
	);

	liveIt(
		"groups unattributed usage and returns numeric empty aggregates without plan traffic",
		async () => {
			const { createApiKeyUsageHandler } = await import(
				"../../../http-api/src/handlers/api-key-usage"
			);
			await key();
			await key("empty-usage");
			await event("unattributed", NOW - DAY, 0, 2, null, null, {
				billingType: null,
			});
			const handler = createApiKeyUsageHandler({ dbOps: db } as APIContext);
			const params = new URLSearchParams({
				range: "custom",
				from: new Date(NOW - DAY).toISOString(),
				to: new Date(NOW).toISOString(),
			});
			const response = await handler("key", params);
			expect(response.status).toBe(200);
			const body = (await response.json()) as ApiKeyUsageResponse;
			expect(body.accounts).toEqual([
				{
					accountId: null,
					accountName: null,
					requests: 1,
					failedAttempts: 0,
					costUsd: 2,
				},
			]);
			expect(body.apiCostUsd).toBe(2);
			expect(body.planValueUsd).toBe(0);
			expect(body.requests).toBe(1);
			const emptyResponse = await handler("empty-usage", params);
			expect(emptyResponse.status).toBe(200);
			const empty = (await emptyResponse.json()) as ApiKeyUsageResponse;
			expect(empty.requests).toBe(0);
			expect(empty.successRate).toBe(0);
			expect(empty.apiCostUsd).toBe(0);
			expect(empty.planValueUsd).toBe(0);
			expect(empty.accounts).toEqual([]);
			expect(empty.models).toEqual([]);
			expect(empty.series).toEqual([]);
		},
	);
});
