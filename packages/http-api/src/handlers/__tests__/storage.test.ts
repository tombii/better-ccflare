/**
 * Tests for createStorageHandler (packages/http-api/src/handlers/storage.ts).
 *
 * Verifies the response shape returned by the /api/storage endpoint:
 *   db_bytes, wal_bytes, integrity_status, last_integrity_check_at,
 *   orphan_pages, last_retention_sweep_at, null_account_rows_24h
 */
import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { createStorageHandler } from "../storage";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

type IntegrityStatus = {
	status: "ok" | "corrupt" | "unchecked";
	lastCheckAt: number | null;
	lastError: string | null;
};

type StorageMetrics = {
	dbBytes: number;
	walBytes: number;
	orphanPages: number;
	lastRetentionSweepAt: number | null;
	nullAccountRows: number;
};

function makeDbOps(
	metrics: Partial<StorageMetrics> = {},
	integrity: Partial<IntegrityStatus> = {},
): DatabaseOperations {
	const resolvedMetrics: StorageMetrics = {
		dbBytes: 1024 * 1024, // 1 MB
		walBytes: 0,
		orphanPages: 0,
		lastRetentionSweepAt: null,
		nullAccountRows: 0,
		...metrics,
	};

	const resolvedIntegrity: IntegrityStatus = {
		status: "ok",
		lastCheckAt: null,
		lastError: null,
		...integrity,
	};

	return {
		getStorageMetrics: mock(async () => resolvedMetrics),
		getIntegrityStatus: mock(() => resolvedIntegrity),
	} as unknown as DatabaseOperations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createStorageHandler", () => {
	describe("response shape", () => {
		it("returns HTTP 200", async () => {
			const handler = createStorageHandler(makeDbOps());
			const response = await handler();
			expect(response.status).toBe(200);
		});

		it("includes all required top-level keys", async () => {
			const handler = createStorageHandler(makeDbOps());
			const body = (await (await handler()).json()) as Record<string, unknown>;

			expect(body).toHaveProperty("db_bytes");
			expect(body).toHaveProperty("wal_bytes");
			expect(body).toHaveProperty("integrity_status");
			expect(body).toHaveProperty("last_integrity_check_at");
			expect(body).toHaveProperty("orphan_pages");
			expect(body).toHaveProperty("last_retention_sweep_at");
			expect(body).toHaveProperty("null_account_rows_24h");
		});

		it("does NOT include snake_case keys that were renamed", async () => {
			const handler = createStorageHandler(makeDbOps());
			const body = (await (await handler()).json()) as Record<string, unknown>;

			// Verify no camelCase leakage from the internal metrics object
			expect(body).not.toHaveProperty("dbBytes");
			expect(body).not.toHaveProperty("walBytes");
			expect(body).not.toHaveProperty("orphanPages");
			expect(body).not.toHaveProperty("nullAccountRows");
		});
	});

	describe("db_bytes and wal_bytes", () => {
		it("maps dbBytes to db_bytes", async () => {
			const handler = createStorageHandler(makeDbOps({ dbBytes: 5_000_000 }));
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.db_bytes).toBe(5_000_000);
		});

		it("maps walBytes to wal_bytes", async () => {
			const handler = createStorageHandler(makeDbOps({ walBytes: 65536 }));
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.wal_bytes).toBe(65536);
		});

		it("wal_bytes is 0 when no WAL file", async () => {
			const handler = createStorageHandler(makeDbOps({ walBytes: 0 }));
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.wal_bytes).toBe(0);
		});
	});

	describe("integrity_status", () => {
		it("returns 'ok' status", async () => {
			const handler = createStorageHandler(makeDbOps({}, { status: "ok" }));
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.integrity_status).toBe("ok");
		});

		it("returns 'corrupt' status", async () => {
			const handler = createStorageHandler(
				makeDbOps({}, { status: "corrupt" }),
			);
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.integrity_status).toBe("corrupt");
		});

		it("returns 'unchecked' status on fresh instance", async () => {
			const handler = createStorageHandler(
				makeDbOps({}, { status: "unchecked" }),
			);
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.integrity_status).toBe("unchecked");
		});
	});

	describe("last_integrity_check_at", () => {
		it("is null when lastCheckAt is null", async () => {
			const handler = createStorageHandler(
				makeDbOps({}, { lastCheckAt: null }),
			);
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.last_integrity_check_at).toBeNull();
		});

		it("is an ISO 8601 string when lastCheckAt is a timestamp", async () => {
			const ts = new Date("2025-01-15T10:30:00.000Z").getTime();
			const handler = createStorageHandler(makeDbOps({}, { lastCheckAt: ts }));
			const body = (await (await handler()).json()) as Record<string, unknown>;

			expect(typeof body.last_integrity_check_at).toBe("string");
			expect(
				Number.isNaN(Date.parse(body.last_integrity_check_at as string)),
			).toBe(false);
			expect(body.last_integrity_check_at).toBe(new Date(ts).toISOString());
		});

		it("ISO timestamp round-trips correctly", async () => {
			const now = Date.now();
			const handler = createStorageHandler(makeDbOps({}, { lastCheckAt: now }));
			const body = (await (await handler()).json()) as Record<string, unknown>;

			expect(Date.parse(body.last_integrity_check_at as string)).toBe(
				new Date(now).getTime(),
			);
		});
	});

	describe("orphan_pages", () => {
		it("maps orphanPages to orphan_pages", async () => {
			const handler = createStorageHandler(makeDbOps({ orphanPages: 17 }));
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.orphan_pages).toBe(17);
		});

		it("orphan_pages is 0 when no free pages", async () => {
			const handler = createStorageHandler(makeDbOps({ orphanPages: 0 }));
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.orphan_pages).toBe(0);
		});
	});

	describe("last_retention_sweep_at", () => {
		it("is null when no retention sweep has run", async () => {
			const handler = createStorageHandler(
				makeDbOps({ lastRetentionSweepAt: null }),
			);
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.last_retention_sweep_at).toBeNull();
		});

		it("is an ISO 8601 string when lastRetentionSweepAt is a timestamp", async () => {
			const ts = new Date("2025-06-01T00:00:00.000Z").getTime();
			const handler = createStorageHandler(
				makeDbOps({ lastRetentionSweepAt: ts }),
			);
			const body = (await (await handler()).json()) as Record<string, unknown>;

			expect(typeof body.last_retention_sweep_at).toBe("string");
			expect(body.last_retention_sweep_at).toBe(new Date(ts).toISOString());
		});
	});

	describe("null_account_rows_24h", () => {
		it("maps nullAccountRows to null_account_rows_24h", async () => {
			const handler = createStorageHandler(makeDbOps({ nullAccountRows: 42 }));
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.null_account_rows_24h).toBe(42);
		});

		it("is 0 when no null-account rows exist", async () => {
			const handler = createStorageHandler(makeDbOps({ nullAccountRows: 0 }));
			const body = (await (await handler()).json()) as Record<string, unknown>;
			expect(body.null_account_rows_24h).toBe(0);
		});
	});

	describe("dependency calls", () => {
		it("calls getStorageMetrics exactly once", async () => {
			const dbOps = makeDbOps();
			const handler = createStorageHandler(dbOps);
			await handler();
			expect(dbOps.getStorageMetrics).toHaveBeenCalledTimes(1);
		});

		it("calls getIntegrityStatus exactly once", async () => {
			const dbOps = makeDbOps();
			const handler = createStorageHandler(dbOps);
			await handler();
			expect(dbOps.getIntegrityStatus).toHaveBeenCalledTimes(1);
		});
	});

	describe("content-type", () => {
		it("returns application/json content-type", async () => {
			const handler = createStorageHandler(makeDbOps());
			const response = await handler();
			expect(response.headers.get("content-type")).toMatch(/application\/json/);
		});
	});
});
