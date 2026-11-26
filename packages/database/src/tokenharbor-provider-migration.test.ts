/**
 * TokenHarbor became a first-class provider. Existing rows created as
 * `anthropic-compatible` with a TokenHarbor endpoint are promoted on boot; all
 * other anthropic-compatible accounts (and every other provider) must stay as
 * they are, and the custom_endpoint must survive.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "./migrations";

function makePreMigrationDb(): Database {
	const db = new Database(":memory:");

	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT DEFAULT '',
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			priority INTEGER DEFAULT 0,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			auto_fallback_enabled INTEGER DEFAULT 0,
			auto_refresh_enabled INTEGER DEFAULT 0,
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			model_mappings TEXT,
			cross_region_mode TEXT,
			model_fallbacks TEXT,
			billing_type TEXT
		)
	`);

	return db;
}

function insertAccount(
	db: Database,
	id: string,
	provider: string,
	customEndpoint: string | null,
): void {
	db.run(
		"INSERT INTO accounts (id, name, provider, custom_endpoint, created_at) VALUES (?, ?, ?, ?, ?)",
		[id, id, provider, customEndpoint, Date.now()],
	);
}

function providerOf(db: Database, id: string): string {
	const row = db
		.query<{ provider: string }, [string]>(
			"SELECT provider FROM accounts WHERE id = ?",
		)
		.get(id);
	return row?.provider as string;
}

describe("Database migration — TokenHarbor provider promotion", () => {
	let db: Database;

	beforeEach(() => {
		db = makePreMigrationDb();
		insertAccount(
			db,
			"plain",
			"anthropic-compatible",
			"https://tokenharbor.ai",
		);
		insertAccount(
			db,
			"prefixed",
			"anthropic-compatible",
			"https://tokenharbor.ai/v1",
		);
		insertAccount(
			db,
			"trailing",
			"anthropic-compatible",
			"https://tokenharbor.ai/",
		);
		insertAccount(
			db,
			"other",
			"anthropic-compatible",
			"https://other-gateway.example",
		);
		insertAccount(
			db,
			"lookalike",
			"anthropic-compatible",
			"https://evil-tokenharbor.ai",
		);
		insertAccount(db, "zai-row", "zai", "https://tokenharbor.ai");
		insertAccount(db, "no-endpoint", "anthropic-compatible", null);
	});

	afterEach(() => {
		db.close();
	});

	it("promotes every anthropic-compatible row on TokenHarbor's host", () => {
		runMigrations(db);

		expect(providerOf(db, "plain")).toBe("tokenharbor");
		expect(providerOf(db, "prefixed")).toBe("tokenharbor");
		expect(providerOf(db, "trailing")).toBe("tokenharbor");
	});

	it("leaves other anthropic-compatible accounts, other providers, and null endpoints alone", () => {
		runMigrations(db);

		expect(providerOf(db, "other")).toBe("anthropic-compatible");
		expect(providerOf(db, "lookalike")).toBe("anthropic-compatible");
		expect(providerOf(db, "zai-row")).toBe("zai");
		expect(providerOf(db, "no-endpoint")).toBe("anthropic-compatible");
	});

	it("keeps the custom_endpoint intact", () => {
		runMigrations(db);

		const row = db
			.query<{ custom_endpoint: string }, [string]>(
				"SELECT custom_endpoint FROM accounts WHERE id = 'prefixed'",
			)
			.get("prefixed");
		expect(row?.custom_endpoint).toBe("https://tokenharbor.ai/v1");
	});

	it("is idempotent across boots", () => {
		runMigrations(db);
		runMigrations(db);

		expect(providerOf(db, "plain")).toBe("tokenharbor");
		expect(providerOf(db, "other")).toBe("anthropic-compatible");
	});
});
