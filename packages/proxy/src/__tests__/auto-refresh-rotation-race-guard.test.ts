/**
 * Tests for the rotation-race guard in AutoRefreshScheduler.flagIfDefinitiveAuthFailure.
 *
 * The proactive refresh paths (qwen/xai, codex) call provider.refreshToken()
 * directly, bypassing the token-manager funnel fixed in Tasks 1-2. If another
 * consumer rotated the refresh token between the scheduler's loop-start
 * snapshot and this refresh attempt, a definitive-looking rejection
 * (invalid_grant, etc.) condemns a superseded token, not the account itself.
 * The guard uses a single compare-and-set UPDATE — condemning the account
 * only if it still holds the exact refresh token this attempt used — instead
 * of a separate read-then-write, closing the race window between them.
 */
import { describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock DB adapter with spies on `run` and `runWithChanges`.
 * `runWithChangesReturn` configures the number of affected rows the CAS
 * UPDATE reports back (0 = no row matched, i.e. rotation race lost).
 */
function makeDb(runWithChangesReturn = 0) {
	const runCalls: Array<[string, unknown[]]> = [];
	const runWithChangesCalls: Array<[string, unknown[]]> = [];
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async () => []),
		runWithChanges: mock(async (sql: string, params: unknown[]) => {
			runWithChangesCalls.push([sql, params]);
			return runWithChangesReturn;
		}),
		runCalls,
		runWithChangesCalls,
	};
}

/** Build a minimal mock ProxyContext. */
function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

/** Instantiate the scheduler without starting the interval. */
async function makeScheduler(db: ReturnType<typeof makeDb>) {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		makeProxyContext() as never,
	) as AutoRefreshScheduler & {
		flagIfDefinitiveAuthFailure(
			error: unknown,
			row: {
				id: string;
				name: string;
				provider: string;
				refresh_token: string;
			},
		): Promise<void>;
	};
}

const row = {
	id: "acc-1",
	name: "test-account",
	provider: "qwen",
	refresh_token: "RT1-consumed",
};
const invalidGrant = new Error(
	"Failed to refresh token for account test-account: invalid_grant: token expired",
);

/** Collect authFailureEvents emitted while running `fn`. */
async function collectEvents(
	fn: () => Promise<void>,
): Promise<AuthFailureEvt[]> {
	const events: AuthFailureEvt[] = [];
	const listener = (e: AuthFailureEvt) => events.push(e);
	authFailureEvents.on("event", listener);
	try {
		await fn();
	} finally {
		authFailureEvents.off("event", listener);
	}
	return events;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AutoRefreshScheduler — rotation-race guard before requires_reauth", () => {
	it("skips flagging when the CAS UPDATE matches no row (refresh token rotated underneath)", async () => {
		const db = makeDb(0);
		const scheduler = await makeScheduler(db);

		const events = await collectEvents(() =>
			scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row),
		);

		const casCall = db.runWithChangesCalls.find(([sql]) =>
			sql.includes("requires_reauth = 1"),
		);
		expect(casCall).toBeDefined();
		expect(
			db.runCalls.find(([sql]) => sql.includes("requires_reauth = 1")),
		).toBeUndefined();
		expect(events).toHaveLength(0);
	});

	it("flags when the CAS UPDATE matches the row (refresh token still current)", async () => {
		const db = makeDb(1);
		const scheduler = await makeScheduler(db);

		const events = await collectEvents(() =>
			scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row),
		);

		expect(db.runWithChangesCalls).toHaveLength(1);
		const [sql, params] = db.runWithChangesCalls[0];
		expect(sql).toContain("requires_reauth = 1");
		expect(params).toEqual(["acc-1", "RT1-consumed"]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			accountId: "acc-1",
			accountName: "test-account",
			provider: "qwen",
			reason: "invalid_grant",
		});
	});

	it("does NOT flag when the DB cannot be written/read", async () => {
		const db = makeDb();
		db.runWithChanges = mock(async () => {
			throw new Error("db unavailable");
		});
		const scheduler = await makeScheduler(db);

		const events = await collectEvents(() =>
			scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row),
		);

		expect(events).toHaveLength(0);
		expect(
			db.runCalls.find(([sql]) => sql.includes("requires_reauth = 1")),
		).toBeUndefined();
	});

	it("does nothing for non-definitive errors", async () => {
		const db = makeDb(1);
		const scheduler = await makeScheduler(db);

		await scheduler.flagIfDefinitiveAuthFailure(
			new Error("upstream 503 timeout"),
			row,
		);

		expect(db.runCalls).toHaveLength(0);
		expect(db.runWithChangesCalls).toHaveLength(0);
	});
});
