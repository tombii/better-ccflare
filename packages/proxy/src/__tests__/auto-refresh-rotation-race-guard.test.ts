/**
 * Tests for the rotation-race guard in AutoRefreshScheduler.flagIfDefinitiveAuthFailure.
 *
 * The proactive refresh paths (qwen/xai, codex) call provider.refreshToken()
 * directly, bypassing the token-manager funnel fixed in Tasks 1-2. If another
 * consumer rotated the refresh token between the scheduler's loop-start
 * snapshot and this refresh attempt, a definitive-looking rejection
 * (invalid_grant, etc.) condemns a superseded token, not the account itself.
 * The guard re-reads the current DB refresh token before flagging
 * requires_reauth and skips the flag when it no longer matches the one this
 * attempt used.
 */
import { describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock DB adapter with a spy on `run` and a canned `query` result. */
function makeDb(queryResult: unknown[] = []) {
	const runCalls: Array<[string, unknown[]]> = [];
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async () => queryResult),
		runCalls,
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

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AutoRefreshScheduler — rotation-race guard before requires_reauth", () => {
	it("skips flagging when the DB refresh token differs from the attempted one", async () => {
		const db = makeDb([{ refresh_token: "RT2-current" }]);
		const scheduler = await makeScheduler(db);

		const events: AuthFailureEvt[] = [];
		const listener = (e: AuthFailureEvt) => events.push(e);
		authFailureEvents.on("event", listener);
		try {
			await scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row);
		} finally {
			authFailureEvents.off("event", listener);
		}

		const flagCall = db.runCalls.find(([sql]) =>
			sql.includes("requires_reauth = 1"),
		);
		expect(flagCall).toBeUndefined();
		expect(events).toHaveLength(0);
	});

	it("flags when the DB refresh token equals the attempted one", async () => {
		const db = makeDb([{ refresh_token: "RT1-consumed" }]);
		const scheduler = await makeScheduler(db);

		await scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row);

		const flagCall = db.runCalls.find(
			([sql, params]) =>
				sql.includes("requires_reauth = 1") &&
				Array.isArray(params) &&
				params[0] === "acc-1",
		);
		expect(flagCall).toBeDefined();
	});

	it("flags when the DB row cannot be read (fail-safe to previous behavior)", async () => {
		const db = makeDb([]);
		db.query = mock(async () => {
			throw new Error("db unavailable");
		});
		const scheduler = await makeScheduler(db);

		await scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row);

		const flagCall = db.runCalls.find(([sql]) =>
			sql.includes("requires_reauth = 1"),
		);
		expect(flagCall).toBeDefined();
	});

	it("does nothing for non-definitive errors", async () => {
		const db = makeDb([{ refresh_token: "RT1-consumed" }]);
		const scheduler = await makeScheduler(db);

		await scheduler.flagIfDefinitiveAuthFailure(
			new Error("upstream 503 timeout"),
			row,
		);

		expect(db.runCalls).toHaveLength(0);
	});
});
