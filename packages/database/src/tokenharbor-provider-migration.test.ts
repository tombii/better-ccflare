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

	// Mirrors ensureSchema's api_keys table so key rows can exist pre-migration.
	db.run(`
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			hashed_key TEXT NOT NULL UNIQUE,
			prefix_last_8 TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			usage_count INTEGER DEFAULT 0,
			is_active INTEGER DEFAULT 1,
			allowed_accounts TEXT,
			allowed_models TEXT,
			allowed_providers TEXT,
			limit_usd REAL,
			limit_window TEXT,
			limit_enforce TEXT,
			limit_window_mode TEXT NOT NULL DEFAULT 'calendar' CHECK (limit_window_mode IN ('calendar', 'rolling')),
			family_combo_overrides TEXT,
			spend_reset_at INTEGER,
			spend_reset_by TEXT
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

function insertApiKey(
	db: Database,
	id: string,
	allowedProviders: string | null,
): void {
	db.run(
		"INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, allowed_providers) VALUES (?, ?, ?, ?, ?, ?)",
		[id, id, `hash-${id}`, "12345678", Date.now(), allowedProviders],
	);
}

function allowedProvidersOf(db: Database, id: string): string | null {
	const row = db
		.query<{ allowed_providers: string | null }, [string]>(
			"SELECT allowed_providers FROM api_keys WHERE id = ?",
		)
		.get(id);
	return row?.allowed_providers ?? null;
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
		insertAccount(
			db,
			"uppercase-port",
			"anthropic-compatible",
			"https://TOKENHARBOR.AI:443/v1",
		);
		insertAccount(
			db,
			"path-lookalike",
			"anthropic-compatible",
			"https://evil.example//tokenharbor.ai",
		);
		insertAccount(
			db,
			"json-endpoint",
			"anthropic-compatible",
			'{"endpoint":"https://tokenharbor.ai"}',
		);
		insertAccount(db, "invalid-json", "anthropic-compatible", '{"endpoint":');

		insertApiKey(db, "key-legacy", '["anthropic-compatible"]');
		insertApiKey(db, "key-openai", '["openai-compatible"]');
		insertApiKey(db, "key-null", null);
		insertApiKey(db, "key-empty", "[]");
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

	it("matches the parsed host, not a LIKE pattern", () => {
		runMigrations(db);

		// Port stripped, host case normalised.
		expect(providerOf(db, "uppercase-port")).toBe("tokenharbor");
		// Hostname is evil.example; the path merely mentions TokenHarbor.
		expect(providerOf(db, "path-lookalike")).toBe("anthropic-compatible");
		// A JSON custom_endpoint resolves through its endpoint field.
		expect(providerOf(db, "json-endpoint")).toBe("tokenharbor");
		expect(providerOf(db, "invalid-json")).toBe("anthropic-compatible");
	});

	it("adds tokenharbor to API keys that allowlist anthropic-compatible", () => {
		runMigrations(db);

		expect(JSON.parse(allowedProvidersOf(db, "key-legacy") as string)).toEqual([
			"anthropic-compatible",
			"tokenharbor",
		]);
		// Every other key keeps NULL, [] or its unrelated allowlist verbatim.
		expect(allowedProvidersOf(db, "key-openai")).toBe('["openai-compatible"]');
		expect(allowedProvidersOf(db, "key-null")).toBeNull();
		expect(allowedProvidersOf(db, "key-empty")).toBe("[]");
	});

	it("does not duplicate tokenharbor when migrations run twice", () => {
		runMigrations(db);
		runMigrations(db);

		expect(JSON.parse(allowedProvidersOf(db, "key-legacy") as string)).toEqual([
			"anthropic-compatible",
			"tokenharbor",
		]);
	});
});
