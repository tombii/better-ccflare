/**
 * Tests for the guarded usage-threshold pause/resume writes.
 *
 * Both writes are issued from a decision made against an account row read a
 * moment earlier. A manual or overage pause can land in between, and it must
 * win: the pause must not overwrite that reason, and the resume must not clear
 * it. The guards live in the SQL, so they are exercised here against a real
 * SQLite table rather than a mock.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency — same pattern as account-pause-reason.test.ts.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

const REASON = "usage_threshold";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			paused INTEGER DEFAULT 0,
			pause_reason TEXT,
			usage_pause_five_hour_threshold INTEGER,
			usage_pause_weekly_threshold INTEGER,
			usage_pause_five_hour_enabled INTEGER NOT NULL DEFAULT 0,
			usage_pause_weekly_enabled INTEGER NOT NULL DEFAULT 0
		)
	`);
	return { db, repo: new AccountRepository(new BunSqlAdapter(db)) };
}

function insertAccount(
	db: Database,
	id: string,
	paused = 0,
	pauseReason: string | null = null,
): void {
	db.run(
		`INSERT INTO accounts (id, name, created_at, paused, pause_reason) VALUES (?, ?, ?, ?, ?)`,
		[id, id, Date.now(), paused, pauseReason],
	);
}

function getAccount(
	db: Database,
	id: string,
): { paused: number; pause_reason: string | null } {
	return db
		.query<{ paused: number; pause_reason: string | null }, [string]>(
			"SELECT paused, pause_reason FROM accounts WHERE id = ?",
		)
		.get(id) as { paused: number; pause_reason: string | null };
}

describe("AccountRepository — usage-threshold pause guards", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	describe("pauseForUsageThreshold", () => {
		it("pauses an account that is still running", async () => {
			insertAccount(db, "acc-1");

			await repo.pauseForUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: REASON,
			});
		});

		it("does not overwrite a manual pause that landed first", async () => {
			insertAccount(db, "acc-1", 1, "manual");

			await repo.pauseForUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: "manual",
			});
		});

		it("does not overwrite an overage pause that landed first", async () => {
			insertAccount(db, "acc-1", 1, "overage");

			await repo.pauseForUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: "overage",
			});
		});
	});

	describe("resumeFromUsageThreshold", () => {
		it("resumes an account it paused itself", async () => {
			insertAccount(db, "acc-1", 1, REASON);

			await repo.resumeFromUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 0,
				pause_reason: null,
			});
		});

		it("leaves a manual pause alone", async () => {
			insertAccount(db, "acc-1", 1, "manual");

			await repo.resumeFromUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: "manual",
			});
		});

		it("leaves an overage pause alone", async () => {
			insertAccount(db, "acc-1", 1, "overage");

			await repo.resumeFromUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: "overage",
			});
		});

		it("does nothing to an account that is already running", async () => {
			insertAccount(db, "acc-1");

			await repo.resumeFromUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 0,
				pause_reason: null,
			});
		});
	});

	describe("setUsagePauseThresholds", () => {
		it("writes both windows together and keeps a percentage when a window is switched off", async () => {
			insertAccount(db, "acc-1");

			await repo.setUsagePauseThresholds(
				"acc-1",
				{ enabled: true, percent: 80 },
				{ enabled: true, percent: 90 },
			);
			expect(
				db.query("SELECT * FROM accounts WHERE id = ?").get("acc-1") as Record<
					string,
					unknown
				>,
			).toMatchObject({
				usage_pause_five_hour_threshold: 80,
				usage_pause_weekly_threshold: 90,
			});

			expect(
				db.query("SELECT * FROM accounts WHERE id = ?").get("acc-1") as Record<
					string,
					unknown
				>,
			).toMatchObject({
				usage_pause_five_hour_enabled: 1,
				usage_pause_weekly_enabled: 1,
			});

			// Switching a window off keeps its number for next time.
			await repo.setUsagePauseThresholds(
				"acc-1",
				{ enabled: false, percent: 80 },
				{ enabled: false, percent: null },
			);
			expect(
				db.query("SELECT * FROM accounts WHERE id = ?").get("acc-1") as Record<
					string,
					unknown
				>,
			).toMatchObject({
				usage_pause_five_hour_threshold: 80,
				usage_pause_five_hour_enabled: 0,
				usage_pause_weekly_threshold: null,
				usage_pause_weekly_enabled: 0,
			});
		});
	});
});
