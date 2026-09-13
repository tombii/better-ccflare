import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	type CodexUsageRefresherDeps,
	createCodexUsageRefresher,
} from "./codex-usage-refresher";

const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Ania Codex",
		provider: "codex",
		access_token: "at",
		refresh_token: "rt",
		custom_endpoint: null,
		...overrides,
	} as unknown as Account;
}

function makeDeps(overrides: Partial<CodexUsageRefresherDeps> = {}) {
	const soon = new Date(Date.now() + 60_000).toISOString();
	const later = new Date(Date.now() + 600_000).toISOString();
	const freeData = {
		five_hour: { utilization: 12, resets_at: soon },
		seven_day: { utilization: 43, resets_at: later },
	};
	const probeData = { seven_day: { utilization: 77, resets_at: later } };
	const calls = {
		free: 0,
		probe: [] as Array<{ endpoint: string; model: string }>,
		cacheSet: [] as Array<{ accountId: string; data: unknown }>,
		snapshots: [] as Array<{
			accountId: string;
			force: boolean;
			usage: unknown;
		}>,
		resets: [] as Array<{ accountId: string; resetMs: number }>,
		sessionResets: [] as string[],
	};
	const deps: CodexUsageRefresherDeps = {
		getAccount: async () => makeAccount(),
		getAccessToken: async () => "access-token",
		fetchFromUsageEndpoint: async () => {
			calls.free += 1;
			return { data: freeData, status: 200 };
		},
		usageEndpointAvailable: (endpoint) => endpoint === DEFAULT_ENDPOINT,
		defaultEndpoint: DEFAULT_ENDPOINT,
		resolvePingModel: async () => "gpt-5.6-sol",
		fetchFromProbe: async (_token, endpoint, model) => {
			calls.probe.push({ endpoint, model });
			return { data: probeData, response: new Response(null, { status: 200 }) };
		},
		probeResetTime: () => null,
		cacheSet: (accountId, data) => {
			calls.cacheSet.push({ accountId, data });
		},
		recordSnapshot: async (accountId, _name, usage, _now, force) => {
			calls.snapshots.push({ accountId, force, usage });
			return true;
		},
		updateRateLimitReset: async (accountId, resetMs) => {
			calls.resets.push({ accountId, resetMs });
		},
		getCachedUsage: () => null,
		resetSession: async (accountId) => {
			calls.sessionResets.push(accountId);
		},
		pinFiveHour: () => false,
		earliestResetMs: (usage) => {
			const five = usage.five_hour as { resets_at?: string | null } | undefined;
			const seven = usage.seven_day as
				| { resets_at?: string | null }
				| undefined;
			const iso = five?.resets_at ?? seven?.resets_at ?? null;
			return iso ? new Date(iso).getTime() : null;
		},
		log: { debug() {}, info() {}, warn() {}, error() {} },
		...overrides,
	};
	return { deps, calls, freeData, probeData, soon };
}

describe("createCodexUsageRefresher", () => {
	it("uses the free usage endpoint first and never calls the probe", async () => {
		const { deps, calls, freeData, soon } = makeDeps();
		const refresh = createCodexUsageRefresher(deps);

		const outcome = await refresh("acc-1");

		expect(outcome.success).toBe(true);
		expect(outcome.message).toContain("5h: 12%");
		expect(outcome.message).toContain("7d: 43%");
		expect(calls.free).toBe(1);
		expect(calls.probe).toEqual([]);
		expect(calls.cacheSet).toEqual([{ accountId: "acc-1", data: freeData }]);
		expect(calls.snapshots).toHaveLength(1);
		expect(calls.snapshots[0].force).toBe(true);
		expect(calls.resets).toEqual([
			{ accountId: "acc-1", resetMs: new Date(soon).getTime() },
		]);
	});

	it("falls back to the /responses probe when the usage endpoint returns no data", async () => {
		const { deps, calls, probeData } = makeDeps({
			fetchFromUsageEndpoint: async () => ({ data: null, status: 403 }),
		});
		const refresh = createCodexUsageRefresher(deps);

		const outcome = await refresh("acc-1");

		expect(outcome.success).toBe(true);
		expect(outcome.message).toContain("5h: n/a");
		expect(outcome.message).toContain("7d: 77%");
		expect(calls.probe).toEqual([
			{ endpoint: DEFAULT_ENDPOINT, model: "gpt-5.6-sol" },
		]);
		expect(calls.cacheSet).toEqual([{ accountId: "acc-1", data: probeData }]);
		expect(calls.snapshots[0].force).toBe(true);
	});

	it("stops at a rate-limited free endpoint instead of spending quota on the probe", async () => {
		const { deps, calls } = makeDeps({
			fetchFromUsageEndpoint: async () => ({ data: null, status: 429 }),
		});
		const refresh = createCodexUsageRefresher(deps);

		const outcome = await refresh("acc-1");

		expect(outcome.success).toBe(false);
		expect(outcome.message).toContain("rate limited");
		expect(outcome.message).toContain("Ania Codex");
		expect(calls.probe).toEqual([]);
		expect(calls.cacheSet).toEqual([]);
	});

	it("skips the usage endpoint for an account on a custom endpoint", async () => {
		const custom = "https://gateway.example/v1/responses";
		const { deps, calls } = makeDeps({
			getAccount: async () => makeAccount({ custom_endpoint: custom }),
		});
		const refresh = createCodexUsageRefresher(deps);

		const outcome = await refresh("acc-1");

		expect(outcome.success).toBe(true);
		expect(calls.free).toBe(0);
		expect(calls.probe).toEqual([{ endpoint: custom, model: "gpt-5.6-sol" }]);
	});

	it("persists the probe's reset time and reports a rate-limited account", async () => {
		const { deps, calls } = makeDeps({
			fetchFromUsageEndpoint: async () => ({ data: null, status: 500 }),
			fetchFromProbe: async () => ({
				data: { seven_day: { utilization: 100, resets_at: null } },
				response: new Response(null, { status: 429 }),
			}),
			probeResetTime: () => 1_789_400_000_000,
		});
		const refresh = createCodexUsageRefresher(deps);

		const outcome = await refresh("acc-1");

		expect(outcome.success).toBe(true);
		expect(outcome.message).toContain("rate limited");
		expect(calls.resets).toContainEqual({
			accountId: "acc-1",
			resetMs: 1_789_400_000_000,
		});
	});

	it("fails when the probe returns no usage headers", async () => {
		const { deps } = makeDeps({
			fetchFromUsageEndpoint: async () => ({ data: null, status: 403 }),
			fetchFromProbe: async () => ({
				data: null,
				response: new Response(null, { status: 400 }),
			}),
		});
		const refresh = createCodexUsageRefresher(deps);

		const outcome = await refresh("acc-1");

		expect(outcome.success).toBe(false);
		expect(outcome.message).toContain("no usage headers (status 400)");
		expect(outcome.message).toContain("gpt-5.6-sol");
	});

	it("rejects non-Codex accounts, missing accounts and accounts without tokens", async () => {
		expect(
			await createCodexUsageRefresher(
				makeDeps({ getAccount: async () => null }).deps,
			)("missing"),
		).toEqual({ success: false, message: "Account missing not found" });

		const notCodex = await createCodexUsageRefresher(
			makeDeps({
				getAccount: async () => makeAccount({ provider: "anthropic" }),
			}).deps,
		)("acc-1");
		expect(notCodex.success).toBe(false);
		expect(notCodex.message).toContain("is not a Codex account");

		const noTokens = await createCodexUsageRefresher(
			makeDeps({
				getAccount: async () =>
					makeAccount({ access_token: null, refresh_token: null }),
			}).deps,
		)("acc-1");
		expect(noTokens.success).toBe(false);
		expect(noTokens.message).toContain("has no tokens");
	});

	it("reports a token refresh failure without calling upstream", async () => {
		const { deps, calls } = makeDeps({
			getAccessToken: async () => {
				throw new Error("refresh_token_reused");
			},
		});
		const refresh = createCodexUsageRefresher(deps);

		const outcome = await refresh("acc-1");

		expect(outcome.success).toBe(false);
		expect(outcome.message).toContain("Could not refresh access token");
		expect(outcome.message).toContain("refresh_token_reused");
		expect(calls.free).toBe(0);
		expect(calls.probe).toEqual([]);
	});
});

describe("createCodexUsageRefresher window rollovers", () => {
	const elapsed = new Date(Date.now() - 60_000).toISOString();
	const inFiveHours = new Date(Date.now() + 5 * 60 * 60_000).toISOString();

	it("resets the session when the free payload shows a real rollover", async () => {
		const fresh = { five_hour: { utilization: 5, resets_at: inFiveHours } };
		const { deps, calls } = makeDeps({
			getAccount: async () =>
				makeAccount({ rate_limit_reset: Date.now() - 60_000 }),
			getCachedUsage: () =>
				({
					five_hour: { utilization: 80, resets_at: elapsed },
				}) as never,
			fetchFromUsageEndpoint: async () => ({ data: fresh, status: 200 }),
		});

		const outcome = await createCodexUsageRefresher(deps)("acc-1");

		expect(outcome.success).toBe(true);
		expect(calls.sessionResets).toEqual(["acc-1"]);
		// The stored reset has been consumed by this very rollover, so the
		// next deadline may replace it.
		expect(calls.resets).toEqual([
			{ accountId: "acc-1", resetMs: new Date(inFiveHours).getTime() },
		]);
	});

	it("does not reset the session when the 5-hour deadline merely slides forward", async () => {
		const inTwoHours = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
		const slid = { five_hour: { utilization: 25, resets_at: inTwoHours } };
		const { deps, calls } = makeDeps({
			getAccount: async () =>
				makeAccount({ rate_limit_reset: Date.now() + 60 * 60_000 }),
			getCachedUsage: () =>
				({
					five_hour: {
						utilization: 20,
						resets_at: new Date(Date.now() + 60 * 60_000).toISOString(),
					},
				}) as never,
			fetchFromUsageEndpoint: async () => ({ data: slid, status: 200 }),
		});

		await createCodexUsageRefresher(deps)("acc-1");

		expect(calls.sessionResets).toEqual([]);
		// The stored reset is still in the future — nothing to preserve.
		expect(calls.resets).toEqual([
			{ accountId: "acc-1", resetMs: new Date(inTwoHours).getTime() },
		]);
	});

	it("keeps an elapsed rate_limit_reset that nothing has consumed yet", async () => {
		// AutoRefreshScheduler's probe gate and codexWindowHasReset both read
		// this column and both need the PAST value until they act on it.
		const { deps, calls } = makeDeps({
			getAccount: async () =>
				makeAccount({ rate_limit_reset: Date.now() - 60_000 }),
			getCachedUsage: () => null,
		});

		const outcome = await createCodexUsageRefresher(deps)("acc-1");

		expect(outcome.success).toBe(true);
		expect(calls.sessionResets).toEqual([]);
		expect(calls.resets).toEqual([]);
		expect(calls.cacheSet).toHaveLength(1);
	});

	it("runs the rollover check on the probe path and still writes its reset", async () => {
		const { deps, calls } = makeDeps({
			fetchFromUsageEndpoint: async () => ({ data: null, status: 403 }),
			getCachedUsage: () =>
				({
					seven_day: { utilization: 80, resets_at: elapsed },
				}) as never,
			probeResetTime: () => 1_789_400_000_000,
		});

		const outcome = await createCodexUsageRefresher(deps)("acc-1");

		expect(outcome.success).toBe(true);
		expect(calls.sessionResets).toEqual(["acc-1"]);
		expect(calls.resets).toEqual([
			{ accountId: "acc-1", resetMs: 1_789_400_000_000 },
		]);
	});
});
