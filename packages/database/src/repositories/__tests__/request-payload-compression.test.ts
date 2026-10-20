/**
 * Integration coverage for payload compression through the repository, i.e.
 * what actually lands in `request_payloads.json` and what comes back out.
 *
 * The unit tests in payload-compression.test.ts / payload-encryption.test.ts
 * pin the codec itself. This file pins the wiring: that savePayload() compresses
 * (not just encrypts) and that every read path decodes.
 *
 * Note on encryption state: the encryption module holds process-wide state that
 * other test files may have initialized with a key, so these assertions must not
 * depend on which prefix wins. They assert the user-visible contract instead —
 * the stored bytes are encoded (not plaintext) and smaller than the input, and
 * every read path returns the exact original.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { PAYLOAD_FLAG_COMPRESSED } from "../../payload-blob";
import { RequestRepository } from "../request.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function insertRequest(db: Database, id: string, timestamp: number): void {
	db.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 error_message, response_time_ms, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
		[id, timestamp],
	);
}

/** Conversation history shaped like real proxy traffic: large and repetitive. */
function largePayload(): unknown {
	return {
		model: "claude-sonnet-4-5",
		messages: Array.from({ length: 100 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `Turn ${i}: ${"the quick brown fox jumps over the lazy dog ".repeat(20)}`,
		})),
	};
}

/** Read the raw stored binary envelope, bypassing the repository's decode step. */
function rawStoredPayload(db: Database, id: string): Uint8Array {
	const row = db
		.query<{ payload: Uint8Array | null }, [string]>(
			`SELECT payload FROM request_payloads WHERE id = ?`,
		)
		.get(id);
	if (!row) throw new Error(`no payload row for ${id}`);
	if (!row.payload) throw new Error(`no binary payload for ${id}`);
	return row.payload;
}

/** Read the legacy text column, which only holds pre-blob rows. */
function rawStoredJson(db: Database, id: string): string {
	const row = db
		.query<{ json: string }, [string]>(
			`SELECT json FROM request_payloads WHERE id = ?`,
		)
		.get(id);
	if (!row) throw new Error(`no payload row for ${id}`);
	return row.json;
}

describe("RequestRepository payload compression", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("stores a large payload compressed, not as plaintext JSON", async () => {
		const id = "req-large";
		insertRequest(db, id, Date.now());
		const data = largePayload();
		const plaintext = JSON.stringify(data);

		await repo.savePayload(id, data);

		const stored = rawStoredPayload(db, id);
		// The envelope is raw bytes, not a base64 text encoding.
		expect(stored).toBeInstanceOf(Uint8Array);
		// Compressed (flag bit 0) — never the raw JSON.
		expect(stored[0] & PAYLOAD_FLAG_COMPRESSED).toBe(PAYLOAD_FLAG_COMPRESSED);
		// The whole point: the on-disk value is materially smaller than the
		// JSON it encodes, with no base64 inflation on top.
		expect(stored.length).toBeLessThan(plaintext.length);
		// The legacy text column stays empty for new rows.
		expect(rawStoredJson(db, id)).toBe("");
	});

	it("round-trips a large payload through savePayload/getPayload", async () => {
		const id = "req-roundtrip";
		insertRequest(db, id, Date.now());
		const data = largePayload();

		await repo.savePayload(id, data);

		expect(await repo.getPayload(id)).toEqual(data);
	});

	it("round-trips through the list path (decryptForList)", async () => {
		const id = "req-list";
		insertRequest(db, id, Date.now());
		const data = largePayload();

		await repo.savePayload(id, data);

		const listed = await repo.listPayloads(10);
		const row = listed.find((r) => r.id === id);
		expect(row).toBeDefined();
		expect(JSON.parse(row?.json as string)).toEqual(data);
	});

	it("still reads legacy plaintext rows written before compression", async () => {
		// A row as it existed before this change: raw JSON, no marker.
		const id = "req-legacy";
		const timestamp = Date.now();
		insertRequest(db, id, timestamp);
		const legacy = JSON.stringify({ legacy: true, note: "pre-compression" });
		db.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[id, legacy, timestamp],
		);

		expect(await repo.getPayload(id)).toEqual(JSON.parse(legacy));
	});

	it("round-trips a tiny payload", async () => {
		const id = "req-tiny";
		insertRequest(db, id, Date.now());
		const data = { a: 1 };

		await repo.savePayload(id, data);

		// No size assertion here: below the compression threshold the value is
		// stored verbatim, but if encryption is active it is still encrypted and
		// legitimately larger. "Verbatim when unencrypted" is pinned
		// deterministically by the codec unit tests instead.
		expect(await repo.getPayload(id)).toEqual(data);
	});

	it("stores a large payload written via savePayloadRaw compressed", async () => {
		// Production writes go through savePayloadRaw, not savePayload — the two
		// are separate methods, so each needs its own coverage. If savePayloadRaw
		// ever stopped routing through the codec, only this test would notice.
		const id = "req-raw";
		insertRequest(db, id, Date.now());
		const plaintext = JSON.stringify(largePayload());

		await repo.savePayloadRaw(id, plaintext);

		const stored = rawStoredPayload(db, id);
		expect(stored.length).toBeLessThan(plaintext.length);
		expect(await repo.getPayload(id)).toEqual(JSON.parse(plaintext));
	});

	it("decodes a large payload through listPayloadsWithAccountNames", async () => {
		// The request-detail list uses this method, not listPayloads. Both call
		// decryptForList, but only exercising this one proves the path the
		// dashboard actually renders stays compressed-aware.
		const id = "req-with-names";
		insertRequest(db, id, Date.now());
		const data = largePayload();

		await repo.savePayload(id, data);

		const listed = await repo.listPayloadsWithAccountNames(10);
		const row = listed.find((r) => r.id === id);
		expect(row).toBeDefined();
		expect(row?.json).not.toBeNull();
		expect(JSON.parse(row?.json as string)).toEqual(data);
	});
});
