/**
 * Tests for createCleanupHandler (packages/http-api/src/handlers/maintenance.ts).
 *
 * Verifies the CleanupResponse shape after the field rename:
 *   - old: { removedRequests, removedPayloads, cutoffIso }
 *   - new: { removedRequests, removedPayloads, payloadCutoffIso, requestCutoffIso }
 */
import { describe, expect, it, mock } from "bun:test";
import { createCleanupHandler } from "../maintenance";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeConfig(
	payloadDays = 3,
	requestDays = 90,
	storePayloads?: boolean,
) {
	return {
		getDataRetentionDays: () => payloadDays,
		getRequestRetentionDays: () => requestDays,
		getStorePayloads: () => storePayloads ?? true,
	} as unknown as import("@better-ccflare/config").Config;
}

function makeDbOps(
	cleanupResult = { removedRequests: 0, removedPayloads: 0 },
	compactResult = {
		walBusy: 0,
		walLog: 0,
		walCheckpointed: 0,
		vacuumed: true,
		error: undefined as string | undefined,
	},
	tableRowCounts?: Array<{ name: string; rowCount: number }>,
	dbSizeBytes?: number,
) {
	return {
		cleanupOldRequests: mock(async () => cleanupResult),
		compact: mock(async () => compactResult),
		getTableRowCounts: mock(async () => tableRowCounts ?? []),
		getDbSizeBytes: mock(async () => dbSizeBytes ?? 0),
	} as unknown as import("@better-ccflare/database").DatabaseOperations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCleanupHandler", () => {
	describe("CleanupResponse shape", () => {
		it("includes payloadCutoffIso in the response body", async () => {
			const handler = createCleanupHandler(makeDbOps(), makeConfig());
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			expect(body).toHaveProperty("payloadCutoffIso");
			expect(typeof body.payloadCutoffIso).toBe("string");
		});

		it("includes requestCutoffIso in the response body", async () => {
			const handler = createCleanupHandler(makeDbOps(), makeConfig());
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			expect(body).toHaveProperty("requestCutoffIso");
			expect(typeof body.requestCutoffIso).toBe("string");
		});

		it("does NOT include the old cutoffIso field", async () => {
			const handler = createCleanupHandler(makeDbOps(), makeConfig());
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			expect(body).not.toHaveProperty("cutoffIso");
		});

		it("includes removedRequests and removedPayloads", async () => {
			const dbOps = makeDbOps({ removedRequests: 10, removedPayloads: 5 });
			const handler = createCleanupHandler(dbOps, makeConfig());
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			expect(body.removedRequests).toBe(10);
			expect(body.removedPayloads).toBe(5);
		});
	});

	describe("cutoff timestamps", () => {
		it("payloadCutoffIso is a valid ISO 8601 string", async () => {
			const handler = createCleanupHandler(makeDbOps(), makeConfig(3, 90));
			const before = Date.now();
			const response = await handler();
			const after = Date.now();
			const body = (await response.json()) as Record<string, unknown>;

			const ts = Date.parse(body.payloadCutoffIso as string);
			expect(Number.isNaN(ts)).toBe(false);

			// Must be approximately (before - 3d) to (after - 3d)
			const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
			expect(ts).toBeGreaterThanOrEqual(before - threeDaysMs - 1000);
			expect(ts).toBeLessThanOrEqual(after - threeDaysMs + 1000);
		});

		it("requestCutoffIso is a valid ISO 8601 string", async () => {
			const handler = createCleanupHandler(makeDbOps(), makeConfig(3, 90));
			const before = Date.now();
			const response = await handler();
			const after = Date.now();
			const body = (await response.json()) as Record<string, unknown>;

			const ts = Date.parse(body.requestCutoffIso as string);
			expect(Number.isNaN(ts)).toBe(false);

			// Must be approximately (before - 90d) to (after - 90d)
			const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
			expect(ts).toBeGreaterThanOrEqual(before - ninetyDaysMs - 1000);
			expect(ts).toBeLessThanOrEqual(after - ninetyDaysMs + 1000);
		});

		it("payloadCutoffIso is earlier than requestCutoffIso when payloadDays < requestDays", async () => {
			const handler = createCleanupHandler(makeDbOps(), makeConfig(3, 90));
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			const payloadTs = Date.parse(body.payloadCutoffIso as string);
			const requestTs = Date.parse(body.requestCutoffIso as string);

			// 3-day cutoff is more recent in absolute time than 90-day cutoff
			// so payloadCutoffIso > requestCutoffIso (less far in the past)
			expect(payloadTs).toBeGreaterThan(requestTs);
		});
	});

	describe("HTTP response", () => {
		it("returns HTTP 200 on successful cleanup", async () => {
			const handler = createCleanupHandler(makeDbOps(), makeConfig());
			const response = await handler();

			expect(response.status).toBe(200);
		});

		it("calls cleanupOldRequests with millisecond values derived from config", async () => {
			const dbOps = makeDbOps();
			const handler = createCleanupHandler(dbOps, makeConfig(3, 90));
			await handler();

			expect(dbOps.cleanupOldRequests).toHaveBeenCalledTimes(1);
			const [payloadMs, requestMs] = (
				dbOps.cleanupOldRequests as ReturnType<typeof mock>
			).mock.calls[0];
			expect(payloadMs).toBe(3 * 24 * 60 * 60 * 1000);
			expect(requestMs).toBe(90 * 24 * 60 * 60 * 1000);
		});

		it("does NOT call compact (cleanup and compact are separate handlers)", async () => {
			const dbOps = makeDbOps();
			const handler = createCleanupHandler(dbOps, makeConfig());
			await handler();

			// Since e2b9d07 cleanup and compact were decoupled into separate HTTP
			// endpoints so that compact errors don't block cleanup responses.
			expect(dbOps.compact).toHaveBeenCalledTimes(0);
		});
	});

	describe("PR-149 additions", () => {
		it("dbSizeBytes appears in response body as a number", async () => {
			const dbOps = makeDbOps(
				{ removedRequests: 0, removedPayloads: 0 },
				undefined,
				[],
				12345,
			);
			const handler = createCleanupHandler(dbOps, makeConfig());
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			expect(body).toHaveProperty("dbSizeBytes");
			expect(typeof body.dbSizeBytes).toBe("number");
			expect(body.dbSizeBytes).toBe(12345);
		});

		it("tableRowCounts appears in response body as an array", async () => {
			const counts = [
				{ name: "requests", rowCount: 42 },
				{ name: "accounts", rowCount: 3 },
			];
			const dbOps = makeDbOps(
				{ removedRequests: 0, removedPayloads: 0 },
				undefined,
				counts,
				0,
			);
			const handler = createCleanupHandler(dbOps, makeConfig());
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			expect(Array.isArray(body.tableRowCounts)).toBe(true);
			expect(body.tableRowCounts).toEqual(counts);
		});

		it("payloadCutoffIso is null when storePayloads=false", async () => {
			const dbOps = makeDbOps();
			const handler = createCleanupHandler(dbOps, makeConfig(3, 90, false));
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			expect(body.payloadCutoffIso).toBeNull();
		});

		it("cleanupOldRequests called with payloadMs=0 when storePayloads=false", async () => {
			const dbOps = makeDbOps();
			const handler = createCleanupHandler(dbOps, makeConfig(3, 90, false));
			await handler();

			expect(dbOps.cleanupOldRequests).toHaveBeenCalledTimes(1);
			const [payloadMs] = (dbOps.cleanupOldRequests as ReturnType<typeof mock>)
				.mock.calls[0];
			expect(payloadMs).toBe(0);
		});

		it("payloadCutoffIso is a valid ISO string when storePayloads=true", async () => {
			const dbOps = makeDbOps();
			const handler = createCleanupHandler(dbOps, makeConfig(3, 90, true));
			const response = await handler();
			const body = (await response.json()) as Record<string, unknown>;

			expect(typeof body.payloadCutoffIso).toBe("string");
			expect(Number.isNaN(Date.parse(body.payloadCutoffIso as string))).toBe(
				false,
			);
		});

		it("getTableRowCounts and getDbSizeBytes are each called once per cleanup", async () => {
			const dbOps = makeDbOps();
			const handler = createCleanupHandler(dbOps, makeConfig());
			await handler();

			expect(dbOps.getTableRowCounts).toHaveBeenCalledTimes(1);
			expect(dbOps.getDbSizeBytes).toHaveBeenCalledTimes(1);
		});
	});
});
