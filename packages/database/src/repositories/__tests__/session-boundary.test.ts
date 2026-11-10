/**
 * A session opens on the request that finds the previous window expired.
 * `getSessionStats` counts rows with `timestamp >= session_start`, so the
 * opening request must not be stamped EARLIER than the boundary it defines.
 *
 * Request rows are stamped with the request's start time (peak badges depend
 * on it). If opening a session stamped `session_start` with the moment its
 * queued write ran instead, that write is always later than the request's
 * start — and the request that opened the session would silently vanish from
 * its own request, token and cost totals.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { AccountRepository } from "../account.repository";
import { RequestRepository } from "../request.repository";
import { StatsRepository } from "../stats.repository";

const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;

describe("session boundary vs request start timestamp", () => {
	let db: Database;
	let adapter: BunSqlAdapter;
	let accounts: AccountRepository;
	let requests: RequestRepository;
	let stats: StatsRepository;

	beforeEach(async () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		adapter = new BunSqlAdapter(db);
		accounts = new AccountRepository(adapter);
		requests = new RequestRepository(adapter);
		stats = new StatsRepository(adapter);
		await adapter.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["acc-1", "a1", "deepseek", "r", "a", Date.now() + 3_600_000, Date.now()],
		);
	});

	afterEach(() => db.close());

	async function saveRequest(id: string, timestamp: number): Promise<void> {
		await requests.save({
			id,
			timestamp,
			method: "POST",
			path: "/v1/messages",
			accountUsed: "acc-1",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 12,
			failoverAttempts: 0,
		});
	}

	async function accountRow(): Promise<{
		session_start: number;
		session_request_count: number;
		last_used: number;
	}> {
		const rows = await adapter.query<{
			session_start: number;
			session_request_count: number;
			last_used: number;
		}>(
			"SELECT session_start, session_request_count, last_used FROM accounts WHERE id = ?",
			["acc-1"],
		);
		const row = rows[0];
		return {
			session_start: Number(row?.session_start),
			session_request_count: Number(row?.session_request_count),
			last_used: Number(row?.last_used),
		};
	}

	async function sessionStart(): Promise<number> {
		return (await accountRow()).session_start;
	}

	it("anchors a new session at the request's start, not at the write time", async () => {
		const startedAt = Date.UTC(2026, 8, 23, 3, 59);
		await accounts.incrementUsage("acc-1", SESSION_DURATION_MS, startedAt);

		expect(await sessionStart()).toBe(startedAt);

		// The request that opened the session is included in its own totals.
		await saveRequest("opening", startedAt);
		const statsMap = await stats.getSessionStats([
			{ id: "acc-1", session_start: startedAt },
		]);
		expect(statsMap.get("acc-1")?.requests).toBe(1);
	});

	it("still excludes a request from before the session boundary", async () => {
		const startedAt = Date.UTC(2026, 8, 23, 4, 0);
		await accounts.incrementUsage("acc-1", SESSION_DURATION_MS, startedAt);
		await saveRequest("older", startedAt - 1);

		const statsMap = await stats.getSessionStats([
			{ id: "acc-1", session_start: startedAt },
		]);
		expect(statsMap.get("acc-1")).toBeUndefined();
	});

	it("keeps an existing session when the request started inside it", async () => {
		const sessionOpenedAt = Date.UTC(2026, 8, 23, 0, 0);
		await accounts.incrementUsage(
			"acc-1",
			SESSION_DURATION_MS,
			sessionOpenedAt,
		);

		// One hour later, still inside the 5h window: the boundary must not move.
		const later = sessionOpenedAt + 60 * 60 * 1000;
		await accounts.incrementUsage("acc-1", SESSION_DURATION_MS, later);
		expect(await sessionStart()).toBe(sessionOpenedAt);
	});

	it("opens a new session when the request started after the window expired", async () => {
		const sessionOpenedAt = Date.UTC(2026, 8, 23, 0, 0);
		await accounts.incrementUsage(
			"acc-1",
			SESSION_DURATION_MS,
			sessionOpenedAt,
		);

		const expired = sessionOpenedAt + SESSION_DURATION_MS;
		await accounts.incrementUsage("acc-1", SESSION_DURATION_MS, expired);
		expect(await sessionStart()).toBe(expired);
	});

	it("does not count a request from before the boundary in session_request_count", async () => {
		const sessionOpenedAt = Date.UTC(2026, 8, 23, 10, 0);
		await accounts.incrementUsage(
			"acc-1",
			SESSION_DURATION_MS,
			sessionOpenedAt,
		);

		// An in-flight request that started 1ms before the session opened, and
		// whose write lands afterwards. getSessionStats excludes its row, so the
		// session's request count must not include it either.
		await accounts.incrementUsage(
			"acc-1",
			SESSION_DURATION_MS,
			sessionOpenedAt - 1,
		);

		const row = await accountRow();
		expect(row.session_start).toBe(sessionOpenedAt);
		expect(row.session_request_count).toBe(1);
	});

	it("keeps last_used at the write time so a late request cannot move it backwards", async () => {
		const requestStartedLongAgo = Date.now() - 60_000;
		const before = Date.now();
		await accounts.incrementUsage(
			"acc-1",
			SESSION_DURATION_MS,
			requestStartedLongAgo,
		);

		const row = await accountRow();
		expect(row.last_used).toBeGreaterThanOrEqual(before);
	});
});
