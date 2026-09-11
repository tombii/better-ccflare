import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import type { BunSqlAdapter as BunSqlAdapterType } from "@better-ccflare/database";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type { Account } from "@better-ccflare/types";
import {
	REAUTH_DEADLINE_CRITICAL_THRESHOLD_MS,
	REAUTH_MANUAL_DEADLINE_MS,
} from "@better-ccflare/types";
import { AlertService } from "../alerts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token-value",
		access_token: "access-token-value",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now() - 100 * DAY_MS,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeConfig(): Config {
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertAnomalyBaselineWindowMinutes: () => 1440,
		getAlertAnomalyLoopMinRequests: () => 25,
		getAlertCooldownMinutes: () => 60,
		getAlertWebhookUrl: () => "",
	}) as unknown as Config;
}

/**
 * `handleReauthDeadlines` is private — it's driven by an hourly `setInterval`
 * in production (see `restartReauthDeadlineTimer`). Invoking it directly here
 * (rather than waiting on the real timer or polling after `start()`) tests
 * the sweep's behavior deterministically without a fake clock.
 */
interface ReauthSweepPrivate {
	handleReauthDeadlines(): Promise<void>;
}

async function runReauthSweep(service: AlertService): Promise<void> {
	await (service as unknown as ReauthSweepPrivate).handleReauthDeadlines();
}

/** ~6 hours left before the 28-day deadline -> "critical" tier. */
function criticalReauthAt(now: number): number {
	return (
		now - REAUTH_MANUAL_DEADLINE_MS + REAUTH_DEADLINE_CRITICAL_THRESHOLD_MS / 2
	);
}

/** ~2 days past the 28-day deadline -> "expired" tier. */
function expiredReauthAt(now: number): number {
	return now - REAUTH_MANUAL_DEADLINE_MS - 2 * DAY_MS;
}

describe("AlertService reauth-deadline sweep (handleReauthDeadlines)", () => {
	it("persists a critical reauth_deadline_warning alert for an eligible account past the critical threshold", async () => {
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const now = Date.now();
		const account = makeAccount({
			id: "acc-critical",
			name: "critical-account",
			last_manual_reauth_at: criticalReauthAt(now),
		});
		const service = new AlertService(adapter, makeConfig(), () =>
			Promise.resolve([account]),
		);
		try {
			await runReauthSweep(service);
			const alerts = await service.listAlerts();
			const reauthAlerts = alerts.filter(
				(a) => a.type === "reauth_deadline_warning",
			);
			expect(reauthAlerts).toHaveLength(1);
			expect(reauthAlerts[0]?.severity).toBe("critical");
			expect(reauthAlerts[0]?.account).toBe("critical-account");
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	it("skips an account with requires_reauth: true even though its predicted deadline has already passed", async () => {
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const now = Date.now();
		const account = makeAccount({
			id: "acc-locked",
			name: "locked-account",
			requires_reauth: true,
			last_manual_reauth_at: expiredReauthAt(now),
		});
		const service = new AlertService(adapter, makeConfig(), () =>
			Promise.resolve([account]),
		);
		try {
			await runReauthSweep(service);
			const alerts = await service.listAlerts();
			// An already-hard-locked account is covered by the existing
			// auth_failure alert; the reauth-deadline sweep must not also
			// fire for it.
			expect(
				alerts.filter((a) => a.type === "reauth_deadline_warning"),
			).toHaveLength(0);
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	it("does not duplicate the alert when the sweep runs twice inside the same cooldown bucket", async () => {
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const now = Date.now();
		const account = makeAccount({
			id: "acc-dup",
			name: "dup-account",
			last_manual_reauth_at: criticalReauthAt(now),
		});
		const service = new AlertService(adapter, makeConfig(), () =>
			Promise.resolve([account]),
		);
		try {
			await runReauthSweep(service);
			await runReauthSweep(service);
			const alerts = await service.listAlerts();
			expect(
				alerts.filter((a) => a.type === "reauth_deadline_warning"),
			).toHaveLength(1);
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	/**
	 * Fake adapter whose `.get()` (the cooldown pre-check inside
	 * `persistAndEmit`, which runs outside persistAndEmit's own try/catch)
	 * throws only for alerts scoped to one specific account, simulating that
	 * account's processing failing mid-sweep (e.g. a PG statement timeout,
	 * per issue #451). Used to prove the per-account try/catch added around
	 * the loop body in `handleReauthDeadlines` keeps the sweep going for
	 * every other account.
	 */
	class PerAccountFailureAdapter implements BunSqlAdapterType {
		readonly isSQLite = true;
		readonly persistedAlertIds: string[] = [];

		async get<T>(_sql: string, params: unknown[] = []): Promise<T | null> {
			const alertId = params[0];
			if (typeof alertId === "string" && alertId.includes("acct-fail")) {
				throw new Error("simulated cooldown-check failure");
			}
			return null;
		}
		async query<T>(): Promise<T[]> {
			return [];
		}
		async run(_sql: string, params: unknown[] = []): Promise<void> {
			const alertId = params[0];
			if (typeof alertId === "string") this.persistedAlertIds.push(alertId);
		}
	}

	it("continues processing the remaining accounts after one account's alert persistence throws", async () => {
		const adapter = new PerAccountFailureAdapter();
		const now = Date.now();
		// The failing account is listed FIRST, so a successful alert for the
		// account after it proves the loop kept going rather than aborting.
		const failingAccount = makeAccount({
			id: "acct-fail",
			name: "failing-account",
			last_manual_reauth_at: criticalReauthAt(now),
		});
		const okAccount = makeAccount({
			id: "acct-ok",
			name: "ok-account",
			last_manual_reauth_at: criticalReauthAt(now),
		});
		const service = new AlertService(
			adapter as unknown as BunSqlAdapterType,
			makeConfig(),
			() => Promise.resolve([failingAccount, okAccount]),
		);
		try {
			// The sweep itself must not reject even though one account's
			// persistence attempt threw.
			await expect(runReauthSweep(service)).resolves.toBeUndefined();
			expect(
				adapter.persistedAlertIds.some((id) => id.includes("acct-ok")),
			).toBe(true);
			expect(
				adapter.persistedAlertIds.some((id) => id.includes("acct-fail")),
			).toBe(false);
		} finally {
			service.stop();
		}
	});
});
