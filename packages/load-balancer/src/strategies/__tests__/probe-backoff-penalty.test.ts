/**
 * The queue penalty for accounts deep in auto-refresh probe backoff.
 *
 * A probe that fails without being counted (a 529 overload, or no response at
 * all) puts the account on an escalating ladder of waits. The first rungs mean
 * nothing much — a blip. From the 1-hour rung up, the provider has been
 * refusing that account for a sustained stretch, which is evidence about live
 * traffic too, so the load balancer sorts it behind accounts with no such
 * history.
 *
 * It stays a penalty and never becomes a ban: a penalised account is still
 * selected when it is the best remaining option, because the alternative is an
 * install where everything is having a bad hour and there is nothing left to
 * route to.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearAllProbeBackoff,
	PROBE_BACKOFF_PENALTY_THRESHOLD_MS,
	setProbeBackoff,
} from "@better-ccflare/core";
import { SessionStrategy } from "@better-ccflare/load-balancer";
import type { Account, RequestMeta } from "@better-ccflare/types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		api_key: null,
		refresh_token: "r",
		access_token: "t",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
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
		...overrides,
	};
}

const meta: RequestMeta = {
	id: "test-request",
	headers: new Headers(),
	path: "/v1/messages",
	method: "POST",
	timestamp: Date.now(),
};

/** Put an account on a rung at or above the penalty threshold. */
function penalise(accountId: string): void {
	setProbeBackoff(accountId, Date.now() + PROBE_BACKOFF_PENALTY_THRESHOLD_MS);
}

let strategy: SessionStrategy;

beforeEach(() => {
	clearAllProbeBackoff();
	strategy = new SessionStrategy(5 * 60 * 60 * 1000);
});

afterEach(() => {
	clearAllProbeBackoff();
});

describe("SessionStrategy — probe-backoff queue penalty", () => {
	it("puts a penalised account behind a healthy one that ranks lower", () => {
		const backedOff = makeAccount({ id: "sick", name: "sick", priority: 0 });
		const healthy = makeAccount({ id: "well", name: "well", priority: 5 });
		penalise(backedOff.id);

		const order = strategy.select([backedOff, healthy], meta);

		// Priority 0 would normally win outright. A sustained refusal outranks it.
		expect(order.map((a) => a.id)).toEqual(["well", "sick"]);
	});

	it("leaves the usual priority order alone when nobody is penalised", () => {
		const first = makeAccount({ id: "first", name: "first", priority: 0 });
		const second = makeAccount({ id: "second", name: "second", priority: 5 });

		const order = strategy.select([second, first], meta);

		expect(order.map((a) => a.id)).toEqual(["first", "second"]);
	});

	it("still selects a penalised account when it is the only one left", () => {
		const backedOff = makeAccount({ id: "sick", name: "sick" });
		penalise(backedOff.id);

		const order = strategy.select([backedOff], meta);

		// A penalty, not a ban. Dropping it here would mean routing nowhere.
		expect(order.map((a) => a.id)).toEqual(["sick"]);
	});

	it("orders penalised accounts among themselves by priority", () => {
		const low = makeAccount({ id: "low", name: "low", priority: 9 });
		const high = makeAccount({ id: "high", name: "high", priority: 1 });
		penalise(low.id);
		penalise(high.id);

		const order = strategy.select([low, high], meta);

		expect(order.map((a) => a.id)).toEqual(["high", "low"]);
	});

	it("restores an account to its place as soon as the backoff deadline passes", () => {
		const backedOff = makeAccount({ id: "sick", name: "sick", priority: 0 });
		const healthy = makeAccount({ id: "well", name: "well", priority: 5 });

		// A deadline already in the past is read as clear — no sweep required, so a
		// stale entry can never keep an account penalised forever.
		setProbeBackoff(backedOff.id, Date.now() - 1000);

		const order = strategy.select([backedOff, healthy], meta);

		expect(order.map((a) => a.id)).toEqual(["sick", "well"]);
	});
});
