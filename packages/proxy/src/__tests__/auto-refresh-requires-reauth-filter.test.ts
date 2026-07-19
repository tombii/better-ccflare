import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";

describe("AutoRefreshScheduler requires_reauth eligibility", () => {
	it("excludes accounts that require manual authentication from probes", async () => {
		let eligibilitySql = "";
		let eligibilityParams: unknown[] = [];
		const schedulerDb = {
			query: mock(async (sql: string, params: unknown[]) => {
				if (
					sql.includes("auto_refresh_enabled") &&
					sql.includes("rate_limit_reset")
				) {
					eligibilitySql = sql;
					eligibilityParams = params;
				}
				return [];
			}),
			run: mock(async () => {}),
		};
		const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
		const scheduler = new AutoRefreshScheduler(
			schedulerDb as never,
			{
				runtime: { port: 8080, clientId: "test-client" },
				refreshInFlight: new Map(),
			} as never,
		) as unknown as { checkAndRefresh(): Promise<void> };

		await scheduler.checkAndRefresh();

		const db = new Database(":memory:");
		try {
			db.run(`
				CREATE TABLE accounts (
					id TEXT PRIMARY KEY,
					name TEXT,
					provider TEXT,
					refresh_token TEXT,
					access_token TEXT,
					expires_at INTEGER,
					rate_limit_reset INTEGER,
					custom_endpoint TEXT,
					paused INTEGER,
					auto_pause_on_overage_enabled INTEGER,
					pause_reason TEXT,
					auto_refresh_enabled INTEGER,
					rate_limited_until INTEGER,
					requires_reauth INTEGER DEFAULT 0
				)
			`);
			db.run(`
				INSERT INTO accounts
					(id, name, provider, refresh_token, access_token, paused,
					 auto_pause_on_overage_enabled, auto_refresh_enabled, requires_reauth)
				VALUES
					('healthy', 'healthy', 'anthropic', 'rt', 'at', 0, 0, 1, 0),
					('dead-auth', 'dead-auth', 'anthropic', 'rt', 'at', 0, 0, 1, 1)
			`);

			const rows = db
				.query(eligibilitySql)
				.all(...(eligibilityParams as [number, number, number])) as Array<{
				name: string;
			}>;

			expect(rows.map((row) => row.name)).toEqual(["healthy"]);
		} finally {
			db.close();
		}
	});
});
