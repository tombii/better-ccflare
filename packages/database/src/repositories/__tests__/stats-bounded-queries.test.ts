/**
 * Tests for the bounded / simplified /api/stats queries on StatsRepository:
 * getRecentErrorGroups (GROUP BY rewrite), getTopModels, getAccountStats
 * (sargable account-id predicate) and getApiKeyStats (single merged query).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Side-effect import: see stats-no-account-binding.test.ts (import cycle).
import "@better-ccflare/core";
import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { StatsRepository } from "../stats.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

interface Req {
	id: string;
	ts: number;
	acct: string | null;
	success?: boolean;
	err?: string | null;
	model?: string | null;
	status?: number | null;
	path?: string;
	failover?: number;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
}

function insertRequest(db: Database, r: Req) {
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, account_used, success,
			error_message, model, status_code, failover_attempts, api_key_id, api_key_name)
		 VALUES (?, ?, 'POST', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			r.id,
			r.ts,
			r.path ?? "/v1/messages",
			r.acct,
			r.success ? 1 : 0,
			r.err ?? null,
			r.model ?? null,
			r.status ?? null,
			r.failover ?? 0,
			r.apiKeyId ?? null,
			r.apiKeyName ?? null,
		],
	);
}

function insertAccount(db: Database, id: string, name: string, extra = {}) {
	const o = {
		provider: "anthropic",
		rate_limited_until: null as number | null,
		rate_limited_reason: null as string | null,
		rate_limited_at: null as number | null,
		...extra,
	};
	db.run(
		`INSERT INTO accounts (id, name, provider, request_count, total_requests, created_at,
			rate_limited_until, rate_limited_reason, rate_limited_at)
		 VALUES (?, ?, ?, 1, 5, ?, ?, ?, ?)`,
		[
			id,
			name,
			o.provider,
			Date.now(),
			o.rate_limited_until,
			o.rate_limited_reason,
			o.rate_limited_at,
		],
	);
}

describe("StatsRepository.getRecentErrorGroups — equivalence", () => {
	let db: Database;
	let repo: StatsRepository;
	beforeEach(() => {
		db = makeDb();
		repo = new StatsRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());

	function seed() {
		insertAccount(db, "a1", "acct-one", {
			rate_limited_until: 9999,
			rate_limited_reason: "upstream_429_with_reset",
			rate_limited_at: 8888,
		});
		insertAccount(db, "a2", "acct-two", { provider: "zai" });
		// group E1 / a1: 3 rows, latest at ts 300
		insertRequest(db, {
			id: "r1",
			ts: 100,
			acct: "a1",
			err: "E1",
			model: "m1",
			status: 500,
			path: "/p1",
			failover: 0,
		});
		insertRequest(db, {
			id: "r2",
			ts: 300,
			acct: "a1",
			err: "E1",
			model: "m2",
			status: 502,
			path: "/p2",
			failover: 2,
		});
		insertRequest(db, {
			id: "r3",
			ts: 200,
			acct: "a1",
			err: "E1",
			model: "m3",
			status: 503,
			path: "/p3",
			failover: 1,
		});
		// same message E1 on a2: separate group
		insertRequest(db, {
			id: "r4",
			ts: 250,
			acct: "a2",
			err: "E1",
			model: "m4",
			status: 429,
			path: "/p4",
			failover: 0,
		});
		// E2: NULL + legacy literal collapse; latest is the literal row
		insertRequest(db, {
			id: "r5",
			ts: 150,
			acct: null,
			err: "E2",
			model: null,
			status: null,
		});
		insertRequest(db, {
			id: "r6",
			ts: 400,
			acct: NO_ACCOUNT_ID,
			err: "E2",
			model: "m5",
			status: 401,
			path: "/p6",
		});
		insertRequest(db, {
			id: "r7",
			ts: 350,
			acct: null,
			err: "E2",
			model: "m6",
			status: 400,
			path: "/p7",
		});
		// E3 / a2: single row
		insertRequest(db, {
			id: "r8",
			ts: 50,
			acct: "a2",
			err: "E3",
			model: "m7",
			status: 500,
			path: "/p8",
		});
		// excluded: empty / null error, older than window, successful w/o error
		insertRequest(db, { id: "r9", ts: 500, acct: "a1", err: "" });
		insertRequest(db, {
			id: "r10",
			ts: 500,
			acct: "a1",
			err: null,
			success: true,
		});
		insertRequest(db, {
			id: "r11",
			ts: 5,
			acct: "a1",
			err: "E1",
			model: "old",
		});
		// E4 / a1: tie on timestamp within the group
		insertRequest(db, {
			id: "t1",
			ts: 320,
			acct: "a1",
			err: "E4",
			model: "tm1",
			status: 500,
			path: "/t1",
		});
		insertRequest(db, {
			id: "t2",
			ts: 320,
			acct: "a1",
			err: "E4",
			model: "tm2",
			status: 500,
			path: "/t2",
		});
	}

	it("matches the previous window-function output exactly", async () => {
		seed();
		const result = await repo.getRecentErrorGroups(10, 10);
		const anthropic = {
			accountName: "acct-one",
			provider: "anthropic",
			rateLimitedUntil: 9999,
			rateLimitedReason: "upstream_429_with_reset",
			rateLimitedAt: 8888,
		};
		const noRl = {
			rateLimitedUntil: null,
			rateLimitedReason: null,
			rateLimitedAt: null,
		};
		// Expected values captured from the previous ROW_NUMBER/COUNT/MIN OVER
		// implementation run against the same seed.
		expect(result).toEqual([
			{
				errorCode: "E2",
				accountId: NO_ACCOUNT_ID,
				accountName: null,
				provider: null,
				occurrenceCount: 3,
				latestTimestamp: 400,
				firstTimestamp: 150,
				latestRequestId: "r6",
				model: "m5",
				statusCode: 401,
				path: "/p6",
				failoverAttempts: 0,
				...noRl,
			},
			{
				errorCode: "E4",
				accountId: "a1",
				occurrenceCount: 2,
				latestTimestamp: 320,
				firstTimestamp: 320,
				latestRequestId: "t1",
				model: "tm1",
				statusCode: 500,
				path: "/t1",
				failoverAttempts: 0,
				...anthropic,
			},
			{
				errorCode: "E1",
				accountId: "a1",
				occurrenceCount: 3,
				latestTimestamp: 300,
				firstTimestamp: 100,
				latestRequestId: "r2",
				model: "m2",
				statusCode: 502,
				path: "/p2",
				failoverAttempts: 2,
				...anthropic,
			},
			{
				errorCode: "E1",
				accountId: "a2",
				accountName: "acct-two",
				provider: "zai",
				occurrenceCount: 1,
				latestTimestamp: 250,
				firstTimestamp: 250,
				latestRequestId: "r4",
				model: "m4",
				statusCode: 429,
				path: "/p4",
				failoverAttempts: 0,
				...noRl,
			},
			{
				errorCode: "E3",
				accountId: "a2",
				accountName: "acct-two",
				provider: "zai",
				occurrenceCount: 1,
				latestTimestamp: 50,
				firstTimestamp: 50,
				latestRequestId: "r8",
				model: "m7",
				statusCode: 500,
				path: "/p8",
				failoverAttempts: 0,
				...noRl,
			},
		]);
	});

	it("applies the limit after ordering by latest timestamp", async () => {
		seed();
		const result = await repo.getRecentErrorGroups(10, 2);
		expect(result.map((g) => g.latestRequestId)).toEqual(["r6", "t1"]);
	});

	it("breaks latest-timestamp ties deterministically at the LIMIT boundary", async () => {
		// Three groups tie on latest timestamp; insertion order is Z, M, A.
		insertRequest(db, { id: "x1", ts: 500, acct: null, err: "Z" });
		insertRequest(db, { id: "x2", ts: 500, acct: null, err: "M" });
		insertRequest(db, { id: "x3", ts: 500, acct: null, err: "A" });
		const result = await repo.getRecentErrorGroups(10, 2);
		// Tiebreak is error_message ASC, so A and M are kept; Z is cut.
		expect(result.map((g) => g.errorCode).sort()).toEqual(["A", "M"]);
	});

	it("breaks ties on account_key when error_message also ties", async () => {
		insertAccount(db, "a1", "acct-one");
		insertAccount(db, "a2", "acct-two");
		insertRequest(db, { id: "y1", ts: 500, acct: "a2", err: "E" });
		insertRequest(db, { id: "y2", ts: 500, acct: "a1", err: "E" });
		const result = await repo.getRecentErrorGroups(10, 1);
		expect(result.map((g) => g.accountId)).toEqual(["a1"]);
	});
});

describe("StatsRepository — bounded top models / account stats / api keys", () => {
	let db: Database;
	let repo: StatsRepository;
	beforeEach(() => {
		db = makeDb();
		repo = new StatsRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());

	it("getTopModels returns lifetime counts and percentages", async () => {
		insertRequest(db, { id: "1", ts: 10, acct: null, model: "a" });
		insertRequest(db, { id: "2", ts: 20, acct: null, model: "a" });
		insertRequest(db, { id: "3", ts: 30, acct: null, model: "a" });
		insertRequest(db, { id: "4", ts: 40, acct: null, model: "b" });
		insertRequest(db, { id: "5", ts: 50, acct: null, model: null });
		expect(await repo.getTopModels(5)).toEqual([
			{ model: "a", count: 3, percentage: 75 },
			{ model: "b", count: 1, percentage: 25 },
		]);
		expect(await repo.getTopModels(1)).toEqual([
			{ model: "a", count: 3, percentage: 75 },
		]);
	});

	it("getAccountStats counts lifetime requests and success rates", async () => {
		insertAccount(db, "a1", "acct-one");
		insertRequest(db, { id: "1", ts: 10, acct: "a1", success: true });
		insertRequest(db, { id: "2", ts: 100, acct: "a1", success: false });
		insertRequest(db, { id: "3", ts: 110, acct: "a1", success: true });
		insertRequest(db, { id: "4", ts: 120, acct: null, success: true });
		insertRequest(db, { id: "5", ts: 5, acct: null, success: false });
		const all = await repo.getAccountStats(10, true);
		const one = all.find((r) => r.name === "acct-one");
		expect(one?.requestCount).toBe(3);
		expect(one?.successRate).toBe(67);
		const none = all.find((r) => r.name === NO_ACCOUNT_ID);
		expect(none?.requestCount).toBe(2);
		expect(none?.successRate).toBe(50);
	});

	it("getApiKeyStats returns counts and success rates", async () => {
		insertRequest(db, {
			id: "1",
			ts: 1,
			acct: null,
			success: true,
			apiKeyId: "k1",
			apiKeyName: "ci",
		});
		insertRequest(db, {
			id: "2",
			ts: 2,
			acct: null,
			success: false,
			apiKeyId: "k1",
			apiKeyName: "ci",
		});
		insertRequest(db, {
			id: "3",
			ts: 3,
			acct: null,
			success: false,
			apiKeyId: "k1",
			apiKeyName: "ci",
		});
		insertRequest(db, {
			id: "4",
			ts: 4,
			acct: null,
			success: true,
			apiKeyId: "k2",
			apiKeyName: "dev",
		});
		insertRequest(db, { id: "5", ts: 5, acct: null, success: true });
		expect(await repo.getApiKeyStats()).toEqual([
			{ id: "k1", name: "ci", requests: 3, successRate: 33 },
			{ id: "k2", name: "dev", requests: 1, successRate: 100 },
		]);
	});
});
