import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../src/migrations";

/**
 * Behavioural tests for the non-destructive account dedup that precedes the
 * CREATE UNIQUE INDEX on (name, provider, COALESCE(custom_endpoint,'')).
 *
 * Background — Greptile P1 (follow-up to #340's atomic-guard fix):
 *   The first dedup implementation kept the arbitrary minimum-rowid row and
 *   DELETED every other row in the tuple group. That silently destroyed
 *   live OAuth refresh tokens (the kept row could be the oldest / expired
 *   one), cascade-deleted every combo_slot referencing a discarded id, and
 *   orphaned requests.account_used / usage_snapshots.account_id rows that
 *   pointed at the deleted id. Production ccmax had exactly this state —
 *   two accounts both named "val" with different live traffic — so the
 *   fix is load-bearing, not theoretical.
 *
 * What this test file proves:
 *   (1) Survivor selection picks the row most likely to still hold working
 *       credentials: most-recent last_used → most-recent
 *       refresh_token_issued_at → most-recent created_at → smallest rowid.
 *   (2) The merged survivor holds the freshest OAuth credentials (refresh +
 *       access + expires_at) from any row in the group, not the survivor's
 *       own (which could be stale).
 *   (3) api_key is preserved when present on any duplicate (API-key
 *       providers must not have their key discarded by an OAuth survivor).
 *   (4) request_count, total_requests, session_request_count are SUMMED
 *       across duplicates — no request accounting is lost.
 *   (5) priority, consecutive_rate_limits, paused, requires_reauth use
 *       MAX — the most-restrictive setting wins.
 *   (6) Dependent rows are REPOINTED before the discarded account rows
 *       are deleted:
 *         - combo_slots.account_id (would otherwise CASCADE-delete)
 *         - requests.account_used (would otherwise orphan)
 *         - usage_snapshots.account_id (would otherwise orphan)
 *   (7) Discarded account rows are deleted.
 *   (8) The end state enforces the UNIQUE constraint — a fresh INSERT of
 *       the same tuple fails.
 */

/**
 * Run the full migration so every column the production accounts table
 * has is present (refresh_token_issued_at, paused, custom_endpoint,
 * session_request_count, etc.) — `ensureSchema` only creates the original
 * schema, and we need the full schema so we can seed realistic duplicate
 * state and observe how the dedup merges each field.
 *
 * Then drop the unique index (if any) so the subsequent `runMigrations`
 * re-enters the dedup block against our seeded duplicates instead of
 * skipping it as a no-op.
 */
function setupFullSchemaForDedupTest(db: Database): void {
	ensureSchema(db);
	runMigrations(db);
	db.exec(`DROP INDEX IF EXISTS idx_accounts_unique_name_provider_endpoint`);
}
describe("Database Migrations — non-destructive account dedup", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("picks the survivor by most-recent last_used", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		// alpha-1 was used more recently (last_used = T0) than alpha-2
		// (last_used = T0 - 10s). Survivor must be alpha-1 even though
		// alpha-2 has a newer created_at and refresh_token.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"r1",
			"a1",
			now - 5000,
			now, // most recent last_used
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"r2",
			"a2",
			now - 1000, // newer created_at
			now - 10000, // older last_used
			now - 1000, // newer refresh_token_issued_at
			null,
		);

		runMigrations(db);

		const survivors = db
			.prepare(
				`SELECT id, refresh_token, access_token FROM accounts WHERE name = 'alpha'`,
			)
			.all() as Array<{
			id: string;
			refresh_token: string;
			access_token: string;
		}>;
		expect(survivors).toHaveLength(1);
		expect(survivors[0]?.id).toBe("alpha-1");
	});

	it("breaks last_used ties by most-recent refresh_token_issued_at", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		// Both rows have NULL last_used, so tie-break on
		// refresh_token_issued_at: alpha-2 (issued at T0) wins over
		// alpha-1 (issued at T0 - 5s).
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"r1",
			"a1",
			now - 5000,
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"r2",
			"a2",
			now - 5000,
			now, // most recent issuance
			null,
		);

		runMigrations(db);

		const survivors = db
			.prepare(`SELECT id FROM accounts WHERE name = 'alpha'`)
			.all() as Array<{ id: string }>;
		expect(survivors).toHaveLength(1);
		expect(survivors[0]?.id).toBe("alpha-2");
	});

	it("breaks refresh_token_issued_at ties by most-recent created_at", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		// Both rows have NULL last_used and NULL refresh_token_issued_at;
		// tie-break on created_at. The newer row (alpha-2) wins.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("alpha-1", "alpha", "anthropic", "r1", "a1", now - 5000, null);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("alpha-2", "alpha", "anthropic", "r2", "a2", now - 1000, null);

		runMigrations(db);

		const survivors = db
			.prepare(`SELECT id FROM accounts WHERE name = 'alpha'`)
			.all() as Array<{ id: string }>;
		expect(survivors).toHaveLength(1);
		expect(survivors[0]?.id).toBe("alpha-2");
	});

	it("breaks full-ties (all timestamps NULL) by smallest rowid", () => {
		setupFullSchemaForDedupTest(db);

		// Same created_at across both rows; no last_used; no
		// refresh_token_issued_at. Final tiebreak: smallest rowid wins.
		const sameCreatedAt = 1000;
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("alpha-1", "alpha", "anthropic", "r1", "a1", sameCreatedAt, null);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("alpha-2", "alpha", "anthropic", "r2", "a2", sameCreatedAt, null);

		runMigrations(db);

		const survivors = db
			.prepare(`SELECT id FROM accounts WHERE name = 'alpha'`)
			.all() as Array<{ id: string }>;
		expect(survivors).toHaveLength(1);
		// First INSERT got the smallest rowid.
		expect(survivors[0]?.id).toBe("alpha-1");
	});

	it("preserves the freshest OAuth credentials (refresh+access+expires) from any duplicate", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		// alpha-1 is the survivor (most recent last_used). Its credentials
		// are STALE; alpha-2 has the freshly-issued credentials.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"OLD_REFRESH",
			"OLD_ACCESS",
			now - 100000,
			now - 10000,
			now, // most recent last_used -> alpha-1 wins
			now - 10000, // issued a long time ago
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"FRESH_REFRESH",
			"FRESH_ACCESS",
			now + 100000,
			now - 5000,
			now - 100000, // old last_used -> alpha-2 is discarded
			now, // issued recently
			null,
		);

		runMigrations(db);

		const survivor = db
			.prepare(
				`SELECT id, refresh_token, access_token, expires_at FROM accounts WHERE name = 'alpha'`,
			)
			.get() as {
			id: string;
			refresh_token: string;
			access_token: string;
			expires_at: number;
		};
		expect(survivor.id).toBe("alpha-1");
		// Credentials were replaced with the FRESH ones from alpha-2.
		expect(survivor.refresh_token).toBe("FRESH_REFRESH");
		expect(survivor.access_token).toBe("FRESH_ACCESS");
		expect(survivor.expires_at).toBe(now + 100000);
	});

	it("preserves the survivor's api_key (API-key providers don't lose their key)", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		// Both rows have the same provider (so they form a duplicate
		// tuple). alpha-1 is the survivor by last_used and has its own
		// api_key. alpha-2 is discarded and ALSO has an api_key. The
		// survivor's own api_key wins via COALESCE — we do NOT silently
		// replace it with a discarded row's key, because the survivor is
		// the actively-used account and its key is what's currently in
		// production. (Test (2) covers the inverse: credentials that the
		// survivor does NOT have, like refresh_token, ARE replaced with
		// the freshest-from-group value.)
		db.prepare(
			`INSERT INTO accounts (id, name, provider, api_key, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"sk-survivor-key",
			now - 5000,
			now, // most recent last_used -> alpha-1 is survivor
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, api_key, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"sk-discarded-key",
			now - 5000,
			now - 100000, // older last_used -> discarded
			now - 1000,
			null,
		);

		runMigrations(db);

		const survivor = db
			.prepare(`SELECT id, api_key FROM accounts WHERE name = 'alpha'`)
			.get() as { id: string; api_key: string | null };
		expect(survivor.id).toBe("alpha-1");
		expect(survivor.api_key).toBe("sk-survivor-key");
	});

	it("falls back to the discarded row's api_key when the survivor has none", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		// alpha-1 is the survivor by last_used but has NO api_key.
		// alpha-2 is discarded but has an api_key. The merged survivor
		// must end up with alpha-2's api_key — otherwise API-key-only
		// providers that lost their key in the duplicate row would end
		// up with a NULL key on the survivor.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, api_key, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			null, // survivor has no api_key
			now - 5000,
			now, // most recent last_used
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, api_key, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"sk-the-real-api-key",
			now - 5000,
			now - 100000,
			now - 5000,
			null,
		);

		runMigrations(db);

		const survivor = db
			.prepare(`SELECT id, api_key FROM accounts WHERE name = 'alpha'`)
			.get() as { id: string; api_key: string | null };
		expect(survivor.api_key).toBe("sk-the-real-api-key");
	});

	it("SUMs request_count / total_requests / session_request_count across duplicates", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, request_count, total_requests, session_request_count, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"r1",
			"a1",
			10,
			100,
			3,
			now - 5000,
			now,
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, request_count, total_requests, session_request_count, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"r2",
			"a2",
			20,
			200,
			4,
			now - 5000,
			now - 100000,
			now - 5000,
			null,
		);

		runMigrations(db);

		const survivor = db
			.prepare(
				`SELECT request_count, total_requests, session_request_count FROM accounts WHERE name = 'alpha'`,
			)
			.get() as {
			request_count: number;
			total_requests: number;
			session_request_count: number;
		};
		expect(survivor.request_count).toBe(30);
		expect(survivor.total_requests).toBe(300);
		expect(survivor.session_request_count).toBe(7);
	});

	it("MAXes priority / consecutive_rate_limits / paused / requires_reauth", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, priority, consecutive_rate_limits, paused, requires_reauth, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"r1",
			"a1",
			2,
			0,
			0,
			0,
			now - 5000,
			now,
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, priority, consecutive_rate_limits, paused, requires_reauth, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"r2",
			"a2",
			5, // higher priority
			3, // more consecutive rate limits
			1, // paused
			1, // requires reauth
			now - 5000,
			now - 100000,
			now - 5000,
			null,
		);

		runMigrations(db);

		const survivor = db
			.prepare(
				`SELECT priority, consecutive_rate_limits, paused, requires_reauth FROM accounts WHERE name = 'alpha'`,
			)
			.get() as {
			priority: number;
			consecutive_rate_limits: number;
			paused: number;
			requires_reauth: number;
		};
		expect(survivor.priority).toBe(5);
		expect(survivor.consecutive_rate_limits).toBe(3);
		expect(survivor.paused).toBe(1);
		expect(survivor.requires_reauth).toBe(1);
	});

	it("repoints combo_slots from discarded ids to the survivor id", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"r1",
			"a1",
			now - 5000,
			now,
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"r2",
			"a2",
			now - 5000,
			now - 100000,
			now - 5000,
			null,
		);

		// Seed a combo with a slot on the DISCARDED id (alpha-2) so we can
		// prove it gets repointed to the survivor (alpha-1). Without
		// repointing, the ON DELETE CASCADE FK would silently drop the slot.
		db.prepare(
			`INSERT INTO combos (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		).run("combo-1", "my-combo", now, now);
		db.prepare(
			`INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("slot-1", "combo-1", "alpha-2", "claude-opus-4-5", 1, 1);

		runMigrations(db);

		const slots = db
			.prepare(`SELECT account_id FROM combo_slots WHERE id = 'slot-1'`)
			.all() as Array<{ account_id: string }>;
		expect(slots).toHaveLength(1);
		expect(slots[0]?.account_id).toBe("alpha-1");

		// And the discarded id is gone.
		const remaining = db
			.prepare(`SELECT id FROM accounts WHERE id = 'alpha-2'`)
			.all() as Array<{ id: string }>;
		expect(remaining).toHaveLength(0);
	});

	it("repoints requests.account_used from discarded ids to the survivor id", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"r1",
			"a1",
			now - 5000,
			now,
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"r2",
			"a2",
			now - 5000,
			now - 100000,
			now - 5000,
			null,
		);

		// Seed requests that reference the DISCARDED id (alpha-2) so we can
		// prove they get repointed to the survivor. Without repointing the
		// request history would orphan and analytics would be broken.
		db.prepare(
			`INSERT INTO requests (id, timestamp, method, path, account_used)
			 VALUES (?, ?, ?, ?, ?)`,
		).run("req-1", now, "POST", "/v1/messages", "alpha-2");
		db.prepare(
			`INSERT INTO requests (id, timestamp, method, path, account_used)
			 VALUES (?, ?, ?, ?, ?)`,
		).run("req-2", now, "POST", "/v1/messages", "alpha-2");
		db.prepare(
			`INSERT INTO requests (id, timestamp, method, path, account_used)
			 VALUES (?, ?, ?, ?, ?)`,
		).run("req-3", now, "POST", "/v1/messages", "alpha-1");

		runMigrations(db);

		const byAccount = db
			.prepare(
				`SELECT account_used, COUNT(*) AS n FROM requests GROUP BY account_used ORDER BY account_used`,
			)
			.all() as Array<{ account_used: string; n: number }>;
		expect(byAccount).toEqual([{ account_used: "alpha-1", n: 3 }]);
	});

	it("repoints usage_snapshots.account_id from discarded ids to the survivor id", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"r1",
			"a1",
			now - 5000,
			now,
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"r2",
			"a2",
			now - 5000,
			now - 100000,
			now - 5000,
			null,
		);

		// Seed usage_snapshots that reference the DISCARDED id (alpha-2).
		// usage_snapshots has no FK — it's a plain TEXT column — so without
		// repointing the rows would orphan and usage-history queries would
		// silently drop the discarded account's window utilization.
		db.prepare(
			`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at)
			 VALUES (?, ?, ?, ?, ?)`,
		).run("alpha-2", now, "five_hour", 42.0, now + 18000000);
		db.prepare(
			`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at)
			 VALUES (?, ?, ?, ?, ?)`,
		).run("alpha-2", now + 1000, "seven_day", 12.5, now + 604800000);

		runMigrations(db);

		const snapshots = db
			.prepare(`SELECT account_id FROM usage_snapshots ORDER BY timestamp`)
			.all() as Array<{ account_id: string }>;
		expect(snapshots).toHaveLength(2);
		expect(snapshots.every((s) => s.account_id === "alpha-1")).toBe(true);
	});

	it("deletes discarded account rows after repointing dependents", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-1",
			"alpha",
			"anthropic",
			"r1",
			"a1",
			now - 5000,
			now,
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-2",
			"alpha",
			"anthropic",
			"r2",
			"a2",
			now - 5000,
			now - 100000,
			now - 5000,
			null,
		);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"alpha-3",
			"alpha",
			"anthropic",
			"r3",
			"a3",
			now - 5000,
			now - 200000,
			now - 5000,
			null,
		);

		runMigrations(db);

		const remaining = db
			.prepare(`SELECT id FROM accounts WHERE name = 'alpha'`)
			.all() as Array<{ id: string }>;
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.id).toBe("alpha-1");

		// And the UNIQUE constraint is now in force — re-adding any of the
		// discarded tuples fails. This proves the index was actually
		// created (which the test below also asserts explicitly).
		let caught: unknown;
		try {
			db.prepare(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run("alpha-2-revived", "alpha", "anthropic", "r", "a", now, null);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("UNIQUE constraint failed");
	});

	it("is a no-op when no duplicate tuples exist", () => {
		setupFullSchemaForDedupTest(db);
		runMigrations(db);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("solo-1", "solo", "anthropic", "r", "a", now);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("solo-2", "solo2", "openai-compatible", "r", "a", now);

		// Idempotent — running again does not change anything.
		runMigrations(db);

		const accounts = db
			.prepare(`SELECT id FROM accounts ORDER BY id`)
			.all() as Array<{ id: string }>;
		expect(accounts.map((a) => a.id)).toEqual(["solo-1", "solo-2"]);
	});

	// Regression for the review finding "Dedup still discards account state":
	// the merge previously covered only a subset of columns, so anything held
	// ONLY on a row about to be discarded was destroyed by the collapse. These
	// assert the config/flag columns that were missing.
	it("adopts config columns held only on a discarded duplicate", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		// Survivor (most recent last_used) carries NO config of its own.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("cfg-1", "cfg", "anthropic", "r1", "a1", now - 5000, now, now, null);
		// Discarded row is the ONLY holder of these values.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint,
			   model_mappings, model_fallbacks, cross_region_mode, billing_type, pause_reason, rate_limited_reason, rate_limit_status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"cfg-2",
			"cfg",
			"anthropic",
			"r2",
			"a2",
			now - 9000,
			now - 90000,
			now - 9000,
			null,
			'{"opus":"sonnet"}',
			'["fallback-model"]',
			"geographic",
			"subscription",
			"overage",
			"model_fallback_429",
			"OK",
		);

		runMigrations(db);

		const survivor = db
			.prepare(
				`SELECT model_mappings, model_fallbacks, cross_region_mode, billing_type,
				        pause_reason, rate_limited_reason, rate_limit_status
				 FROM accounts WHERE name = 'cfg'`,
			)
			.get() as Record<string, string | null>;
		expect(survivor.model_mappings).toBe('{"opus":"sonnet"}');
		expect(survivor.model_fallbacks).toBe('["fallback-model"]');
		expect(survivor.cross_region_mode).toBe("geographic");
		expect(survivor.billing_type).toBe("subscription");
		expect(survivor.pause_reason).toBe("overage");
		expect(survivor.rate_limited_reason).toBe("model_fallback_429");
		expect(survivor.rate_limit_status).toBe("OK");
	});

	it("MAXes the integer-boolean feature flags (enabled on any duplicate wins)", () => {
		setupFullSchemaForDedupTest(db);

		const now = Date.now();
		// These columns are INTEGER, not BOOLEAN — 0 is a real stored value, not
		// "unset". MAX encodes a deliberate policy: if any duplicate had the
		// feature switched on, the survivor keeps it on. The important part is
		// that none of them silently become NULL.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint,
			   auto_fallback_enabled, auto_refresh_enabled, auto_pause_on_overage_enabled, peak_hours_pause_enabled)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
		).run("flg-1", "flg", "anthropic", "r1", "a1", now - 5000, now, now, null);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used, refresh_token_issued_at, custom_endpoint,
			   auto_fallback_enabled, auto_refresh_enabled, auto_pause_on_overage_enabled, peak_hours_pause_enabled)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`,
		).run(
			"flg-2",
			"flg",
			"anthropic",
			"r2",
			"a2",
			now - 9000,
			now - 90000,
			now - 9000,
			null,
		);

		runMigrations(db);

		const survivor = db
			.prepare(
				`SELECT auto_fallback_enabled, auto_refresh_enabled,
				        auto_pause_on_overage_enabled, peak_hours_pause_enabled
				 FROM accounts WHERE name = 'flg'`,
			)
			.get() as Record<string, number | null>;
		expect(survivor.auto_fallback_enabled).toBe(1);
		expect(survivor.auto_refresh_enabled).toBe(1);
		expect(survivor.auto_pause_on_overage_enabled).toBe(1);
		expect(survivor.peak_hours_pause_enabled).toBe(1);
		// None may become NULL — a NULL here is indistinguishable from "off"
		// at some call sites and is exactly the silent corruption to avoid.
		for (const v of Object.values(survivor)) {
			expect(v).not.toBeNull();
		}
	});
});
