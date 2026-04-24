/**
 * Tests for clearRequestHistory (packages/cli-commands/src/commands/stats.ts).
 *
 * The function now takes (dbOps, config) and returns
 * { removedRequests, removedPayloads } — not the old { count } shape.
 */
import { describe, expect, it, mock } from "bun:test";
import { clearRequestHistory } from "../stats";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeConfig(payloadDays = 3, requestDays = 90) {
	return {
		getDataRetentionDays: () => payloadDays,
		getRequestRetentionDays: () => requestDays,
	} as unknown as import("@better-ccflare/config").Config;
}

function makeDbOps(result: {
	removedRequests: number;
	removedPayloads: number;
}) {
	return {
		cleanupOldRequests: mock(async () => result),
	} as unknown as import("@better-ccflare/database").DatabaseOperations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clearRequestHistory", () => {
	describe("signature: accepts (dbOps, config)", () => {
		it("calls cleanupOldRequests with payloadMs derived from config.getDataRetentionDays()", async () => {
			const dbOps = makeDbOps({ removedRequests: 0, removedPayloads: 0 });
			const config = makeConfig(3, 90);

			await clearRequestHistory(dbOps, config);

			expect(dbOps.cleanupOldRequests).toHaveBeenCalledTimes(1);
			const [payloadMs] = (dbOps.cleanupOldRequests as ReturnType<typeof mock>)
				.mock.calls[0];
			// 3 days in milliseconds
			expect(payloadMs).toBe(3 * 24 * 60 * 60 * 1000);
		});

		it("calls cleanupOldRequests with requestMs derived from config.getRequestRetentionDays()", async () => {
			const dbOps = makeDbOps({ removedRequests: 0, removedPayloads: 0 });
			const config = makeConfig(3, 90);

			await clearRequestHistory(dbOps, config);

			const [, requestMs] = (
				dbOps.cleanupOldRequests as ReturnType<typeof mock>
			).mock.calls[0];
			// 90 days in milliseconds
			expect(requestMs).toBe(90 * 24 * 60 * 60 * 1000);
		});

		it("passes different payloadDays when config specifies a different value", async () => {
			const dbOps = makeDbOps({ removedRequests: 0, removedPayloads: 0 });
			const config = makeConfig(7, 180);

			await clearRequestHistory(dbOps, config);

			const [payloadMs, requestMs] = (
				dbOps.cleanupOldRequests as ReturnType<typeof mock>
			).mock.calls[0];
			expect(payloadMs).toBe(7 * 24 * 60 * 60 * 1000);
			expect(requestMs).toBe(180 * 24 * 60 * 60 * 1000);
		});
	});

	describe("return value: { removedRequests, removedPayloads }", () => {
		it("returns removedRequests and removedPayloads from dbOps.cleanupOldRequests", async () => {
			const dbOps = makeDbOps({ removedRequests: 42, removedPayloads: 17 });
			const config = makeConfig();

			const result = await clearRequestHistory(dbOps, config);

			expect(result.removedRequests).toBe(42);
			expect(result.removedPayloads).toBe(17);
		});

		it("returns zero counts when nothing was deleted", async () => {
			const dbOps = makeDbOps({ removedRequests: 0, removedPayloads: 0 });
			const config = makeConfig();

			const result = await clearRequestHistory(dbOps, config);

			expect(result.removedRequests).toBe(0);
			expect(result.removedPayloads).toBe(0);
		});

		it("does NOT return a { count } field (old signature removed)", async () => {
			const dbOps = makeDbOps({ removedRequests: 5, removedPayloads: 3 });
			const config = makeConfig();

			const result = await clearRequestHistory(dbOps, config);

			// Confirm old shape is absent
			expect(result).not.toHaveProperty("count");
		});

		it("propagates large deletion counts accurately", async () => {
			const dbOps = makeDbOps({
				removedRequests: 100_000,
				removedPayloads: 50_000,
			});
			const config = makeConfig();

			const result = await clearRequestHistory(dbOps, config);

			expect(result.removedRequests).toBe(100_000);
			expect(result.removedPayloads).toBe(50_000);
		});
	});
});
