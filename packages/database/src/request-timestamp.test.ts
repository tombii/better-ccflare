/**
 * The requests row is written after the response finishes, so stamping it
 * with "now" records the COMPLETION time. Anything derived from that column
 * then disagrees with the live SSE summary, which reports the start time —
 * e.g. a stream that starts 03:59 UTC and ends 04:01 UTC would show the
 * DeepSeek Peak badge live and lose it on reload.
 *
 * Callers that know the true start pass it; everything else keeps the old
 * "stamp on write" behaviour.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "./migrations";
import { RequestRepository } from "./repositories/request.repository";

describe("RequestRepository.save — timestamp", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	const base = {
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 12,
		failoverAttempts: 0,
	};

	function storedTimestamp(id: string): number {
		const row = db
			.prepare("SELECT timestamp FROM requests WHERE id = ?")
			.get(id) as { timestamp: number };
		return Number(row.timestamp);
	}

	it("stores the caller-supplied start timestamp", async () => {
		const start = Date.UTC(2026, 8, 23, 3, 59);
		await repo.save({ ...base, id: "ts-explicit", timestamp: start });
		expect(storedTimestamp("ts-explicit")).toBe(start);
	});

	it("falls back to the write time when no timestamp is supplied", async () => {
		const before = Date.now();
		await repo.save({ ...base, id: "ts-default" });
		const after = Date.now();
		const stored = storedTimestamp("ts-default");
		expect(stored).toBeGreaterThanOrEqual(before);
		expect(stored).toBeLessThanOrEqual(after);
	});
});
