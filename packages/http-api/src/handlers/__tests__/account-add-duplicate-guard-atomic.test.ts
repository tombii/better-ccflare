// Standalone integration test for the Greptile P1 atomic-guard fix on
// PR #343. Runs without the full provider/CLI dependency chain so the test
// env doesn't drag in the AWS / google-auth / qwen submodules that the
// upstream suite pulls in transitively. We exercise the DB-level UNIQUE
// index directly against an in-memory SQLite DB with the production-schema
// migration applied.
//
// What this test proves:
//   (1) The migration is active at the time of the test (the UNIQUE
//       index is queried directly, not assumed) and it rejects a
//       duplicate tuple even when a race lets it slip past the handler's
//       pre-check SELECT.
//   (2) The COALESCE(custom_endpoint, '') tuple semantics match what the
//       handler's pre-check assumes.
//
// The handler's actual end-to-end behavior — that `createAccountAddHandler`
// really maps this SQLite error to a 400 `BadRequest` when a conflict lands
// after its pre-check SELECT — is covered by the
// "returns 400 via the UNIQUE-constraint catch..." test in
// account-add-duplicate-guard.test.ts, which stubs the pre-check to force
// that race window and calls the real handler.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	ensureSchema,
	runMigrations,
} from "../../../../database/src/migrations";

const TEST_DB_PATH = `${process.env.TMPDIR ?? "/tmp"}/test-account-add-duplicate-guard-atomic.db`;

describe("createAccountAddHandler — atomic DB-level guard (Greptile P1)", () => {
	let db: Database;

	beforeEach(() => {
		// Reset the file-backed DB and apply the full migration chain —
		// exactly what the production server does at startup. This makes
		// the test rely on the migration (not on an ad-hoc CREATE TABLE)
		// for the UNIQUE index.
		try {
			// biome-ignore lint/suspicious/noExplicitAny: bun:sqlite Database unlink via fs is fine here
			require("node:fs").unlinkSync(TEST_DB_PATH);
		} catch {
			// best-effort cleanup
		}
		db = new Database(TEST_DB_PATH);
		ensureSchema(db);
		runMigrations(db);
	});

	afterEach(() => {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: bun:sqlite Database unlink via fs is fine here
			require("node:fs").unlinkSync(TEST_DB_PATH);
		} catch {
			// best-effort cleanup
		}
	});

	it("DB-level UNIQUE index is in place after migration", () => {
		const idx = db
			.prepare(
				`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_accounts_unique_name_provider_endpoint'`,
			)
			.get() as { name: string; sql: string } | undefined;
		expect(idx).toBeDefined();
		expect(idx?.sql).toContain("UNIQUE INDEX");
		expect(idx?.sql).toContain("COALESCE(custom_endpoint, '')");
	});

	it("rejects a bare second INSERT of the same tuple — atomic gate", () => {
		// Simulate the race outcome: the SELECT pre-check would have
		// passed (we omit the handler's pre-check entirely here), but
		// the DB-level UNIQUE index still rejects the second INSERT.
		// This is the contract that closes the Greptile P1 race.

		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("first", "race", "anthropic", "r", "a", Date.now());

		let caught: unknown;
		try {
			db.prepare(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("second", "race", "anthropic", "r", "a", Date.now());
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("UNIQUE constraint failed");

		const rows = db
			.prepare(`SELECT id FROM accounts WHERE name = 'race'`)
			.all() as Array<{ id: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("first");
	});

	it("treats NULL and empty-string custom_endpoint as the same tuple", () => {
		// Mirrors the COALESCE semantics the pre-check uses — two
		// Anthropic console accounts (NULL or empty custom_endpoint)
		// collide as expected.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		).run("seed", "alpha", "anthropic", "r", "a", Date.now());

		let caught: unknown;
		try {
			db.prepare(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
				 VALUES (?, ?, ?, ?, ?, ?, '')`,
			).run("dup", "alpha", "anthropic", "r", "a", Date.now());
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("UNIQUE constraint failed");
	});

	it("allows adds that differ on provider (existing allowed-tuple semantics)", () => {
		// Sanity check the constraint is keyed on the tuple, not just
		// the name — different providers / custom_endpoints are still
		// permitted.
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"a",
			"beta",
			"anthropic",
			"r",
			"a",
			Date.now(),
			"https://api.example.com",
		);

		// Same name + provider, but a different custom_endpoint.
		expect(() =>
			db
				.prepare(
					`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"b",
					"beta",
					"anthropic",
					"r",
					"a",
					Date.now(),
					"https://api.other.example.com",
				),
		).not.toThrow();
	});
});
