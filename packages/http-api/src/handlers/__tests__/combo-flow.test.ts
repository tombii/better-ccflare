import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	RequestRepository,
	runMigrations,
} from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import {
	markModelCooling,
	resetModelCooldownsForTests,
} from "@better-ccflare/proxy";
import type {
	Combo,
	ComboFlowResponse,
	ComboSlot,
} from "@better-ccflare/types";
import { createComboFlowHandler } from "../combos-flow";

/**
 * GET /api/combos/flow — family → combo → slot flow with 24h stats.
 *
 * Combo/account reads are mocked (same minimal DatabaseOperations pattern as
 * combo-get-cooldown.test.ts); the stats come from a REAL in-memory SQLite
 * database so the aggregate SQL itself (COUNT/SUM/AVG, `= TRUE`, `> 0`) is
 * exercised rather than stubbed.
 */

const NOW = Date.now();
const HOUR = 3_600_000;

let db: Database;

function insertRequest(row: {
	id: string;
	comboName: string;
	timestamp: number;
	accountUsed: string | null;
	originalModel?: string | null;
	appliedModel?: string | null;
	/** Model the upstream reported (reflects a combo-slot override). */
	servedModel?: string | null;
	success: boolean;
	statusCode?: number | null;
	errorMessage?: string | null;
	responseTimeMs?: number | null;
	failoverAttempts?: number;
}): void {
	db.prepare(
		`INSERT INTO requests (id, method, path, timestamp, account_used, status_code,
			success, error_message, response_time_ms, failover_attempts, combo_name,
			original_model, applied_model, model)
		 VALUES (?, 'POST', '/v1/messages', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.id,
		row.timestamp,
		row.accountUsed,
		row.statusCode ?? (row.success ? 200 : 500),
		row.success ? 1 : 0,
		row.errorMessage ?? null,
		row.responseTimeMs ?? null,
		row.failoverAttempts ?? 0,
		row.comboName,
		row.originalModel ?? null,
		row.appliedModel ?? null,
		row.servedModel ?? null,
	);
}

function makeAdapter() {
	return {
		query: async (sql: string, params: unknown[] = []) =>
			db.query(sql).all(...(params as never[])),
	};
}

interface FakeOpts {
	combos?: Combo[];
	slots?: Record<string, ComboSlot[]>;
	assignments?: Array<{
		family: string;
		combo_id: string | null;
		enabled: boolean;
	}>;
	accounts?: Array<{ id: string; name: string; provider: string }>;
}

function makeOps(opts: FakeOpts = {}) {
	const combos = opts.combos ?? [];
	const slots = opts.slots ?? {};
	const assignments = opts.assignments ?? [];
	const accounts = opts.accounts ?? [];
	return {
		listCombos: async () => combos,
		getComboSlots: async (comboId: string) => slots[comboId] ?? [],
		getFamilyAssignments: async () => assignments,
		getAllAccounts: async () => accounts,
		getComboRoutingAggregates: (sinceMs: number) =>
			// Delegate to the REAL repository so the aggregate SQL itself (column
			// list, GROUP BY, success coercion) is exercised — a fake copy here
			// silently drifted from the production query once already.
			new RequestRepository(new BunSqlAdapter(db)).getComboRoutingAggregates(
				sinceMs,
			),
		getAdapter: () => makeAdapter(),
	};
}

// biome-ignore lint/suspicious/noExplicitAny: minimal DatabaseOperations mock
const asOps = (o: unknown) => o as any as DatabaseOperations;

function combo(id: string, name: string, enabled = true): Combo {
	return {
		id,
		name,
		description: null,
		enabled,
		created_at: NOW,
		updated_at: NOW,
	};
}

function slot(
	id: string,
	comboId: string,
	accountId: string,
	model: string,
	priority: number,
	enabled = true,
): ComboSlot {
	return {
		id,
		combo_id: comboId,
		account_id: accountId,
		model,
		priority,
		enabled,
	};
}

const ACCOUNTS = [
	{ id: "acc-1", name: "alpha", provider: "anthropic" },
	{ id: "acc-2", name: "beta", provider: "ollama" },
	{ id: "acc-3", name: "gamma", provider: "codebuddy" },
];

async function getFlow(
	opts: FakeOpts,
	observations: Record<string, unknown> = {},
	options: {
		getRoutingFlags?: () => {
			combosEnabled: boolean;
			forceAccountModel: boolean;
		};
	} = {},
): Promise<ComboFlowResponse> {
	const handler = createComboFlowHandler(
		asOps(makeOps(opts)),
		() => {
			// biome-ignore lint/suspicious/noExplicitAny: test shape
			return observations as any;
		},
		options,
	);
	const res = await handler();
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		success: boolean;
		data: ComboFlowResponse;
	};
	expect(body.success).toBe(true);
	return body.data;
}

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	resetModelCooldownsForTests();
});

afterEach(() => {
	resetModelCooldownsForTests();
	db.close();
});

describe("GET /api/combos/flow", () => {
	it("renders every known family; an unassigned family has a null combo", async () => {
		const data = await getFlow({ combos: [combo("c1", "Main")] });
		const families = Object.fromEntries(
			data.families.map((f) => [f.family, f]),
		);
		expect(Object.keys(families).sort()).toEqual([
			"fable",
			"haiku",
			"opus",
			"sonnet",
		]);
		for (const family of data.families) {
			expect(family.combo).toBeNull();
			expect(family.assignmentEnabled).toBe(false);
			expect(family.observation).toBeNull();
		}
		expect(data.windows.requestsHours).toBe(24);
	});

	it("reports the assigned combo and disables assignment when the row is disabled", async () => {
		const data = await getFlow({
			combos: [combo("c1", "Main", false)],
			assignments: [
				{ family: "sonnet", combo_id: "c1", enabled: true },
				{ family: "opus", combo_id: "c1", enabled: false },
			],
		});
		const sonnet = data.families.find((f) => f.family === "sonnet");
		const opus = data.families.find((f) => f.family === "opus");
		expect(sonnet).toMatchObject({
			assignmentEnabled: true,
			combo: { id: "c1", name: "Main", enabled: false },
		});
		expect(opus).toMatchObject({
			assignmentEnabled: false,
			combo: { id: "c1", name: "Main", enabled: false },
		});
		// familyCount counts assignment references regardless of enabled.
		expect(data.combos[0].familyCount).toBe(2);
	});

	it("marks a cooling slot unavailable with its cooldown deadline, and a missing account unavailable", async () => {
		const until = Date.now() + 10 * 60 * 1000;
		markModelCooling("acc-1", "claude-sonnet-4-5", until);
		const data = await getFlow({
			combos: [combo("c1", "Main")],
			slots: {
				c1: [
					slot("s2", "c1", "acc-2", "", 1),
					slot("s1", "c1", "acc-1", "claude-sonnet-4-5", 0),
					slot("s3", "c1", "acc-gone", "m", 2),
				],
			},
			accounts: ACCOUNTS,
		});
		const slots = data.combos[0].slots;
		expect(slots.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
		expect(slots[0]).toMatchObject({
			accountName: "alpha",
			provider: "anthropic",
			cooldownUntil: until,
			available: false,
		});
		expect(slots[1]).toMatchObject({
			accountName: "beta",
			model: "",
			passthrough: true,
			cooldownUntil: null,
			available: true,
		});
		expect(slots[2]).toMatchObject({
			accountId: "acc-gone",
			accountName: null,
			cooldownUntil: null,
			available: false,
		});
	});

	it("enumerates model cooldowns on a passthrough slot", async () => {
		const untilA = Date.now() + 5 * 60 * 1000;
		const untilB = Date.now() + 15 * 60 * 1000;
		markModelCooling("acc-2", "glm-4.5", untilB);
		markModelCooling("acc-2", "glm-4.5-air", untilA);
		const data = await getFlow({
			combos: [combo("c1", "Main")],
			slots: {
				c1: [
					slot("s1", "c1", "acc-2", "", 0),
					// A non-passthrough slot on the same account only carries its
					// own (account, model) deadline.
					slot("s2", "c1", "acc-2", "glm-4.5", 1),
				],
			},
			accounts: ACCOUNTS,
		});
		// The passthrough slot's "" model never matches a cooldown key, but the
		// account's model cooldowns are surfaced so the UI can explain that its
		// availability is model-dependent.
		expect(data.combos[0].slots[0].cooldownUntil).toBeNull();
		expect(data.combos[0].slots[0].cooldowns).toEqual([
			{ model: "glm-4.5-air", until: untilA },
			{ model: "glm-4.5", until: untilB },
		]);
		expect(data.combos[0].slots[1].cooldownUntil).toBe(untilB);
		expect(data.combos[0].slots[1].cooldowns).toBeUndefined();
	});

	it("marks a paused slot unavailable even without a model cooldown", async () => {
		// A paused account cannot be routed to, but it has no (account, model)
		// cooldown deadline either — the flow view must not call it available.
		const data = await getFlow({
			combos: [combo("c1", "Main")],
			slots: { c1: [slot("s1", "c1", "acc-1", "m", 0)] },
			accounts: [{ ...ACCOUNTS[0], paused: true }],
		});
		expect(data.combos[0].slots[0]).toMatchObject({
			cooldownUntil: null,
			available: false,
		});
	});

	it("marks a usage-exhausted slot unavailable", async () => {
		// The selector gates on the representative usage snapshot, so 100%
		// utilization with a future reset means the slot cannot be routed to
		// even though the account itself is neither paused nor rate-limited.
		usageCache.set("acc-1", {
			five_hour: {
				utilization: 100,
				resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			},
		} as never);
		try {
			const data = await getFlow({
				combos: [combo("c1", "Main")],
				slots: { c1: [slot("s1", "c1", "acc-1", "m", 0)] },
				accounts: ACCOUNTS,
			});
			expect(data.combos[0].slots[0]).toMatchObject({
				cooldownUntil: null,
				available: false,
			});
		} finally {
			usageCache.delete("acc-1");
		}
	});

	it("returns zeroed stats with a null success rate when there are no rows", async () => {
		const data = await getFlow({
			combos: [combo("c1", "Main")],
			slots: { c1: [slot("s1", "c1", "acc-1", "m", 0)] },
			accounts: ACCOUNTS,
		});
		expect(data.combos[0].stats).toEqual({
			requests: 0,
			successRate: null,
			failoverRequests: 0,
			avgResponseMs: null,
			errorTop: [],
			pairings: [],
		});
	});

	it("aggregates only this combo's rows inside the 24h window", async () => {
		insertRequest({
			id: "r1",
			comboName: "Main",
			timestamp: NOW,
			accountUsed: "acc-1",
			originalModel: "claude-sonnet-4-5",
			appliedModel: "glm-4.5",
			servedModel: "glm-4.5",
			success: true,
			responseTimeMs: 1000,
		});
		insertRequest({
			id: "r2",
			comboName: "Main",
			timestamp: NOW,
			accountUsed: "acc-1",
			originalModel: "claude-sonnet-4-5",
			appliedModel: "glm-4.5",
			servedModel: "glm-4.5",
			success: false,
			statusCode: 429,
			errorMessage: "Rate limited",
			responseTimeMs: 3000,
			failoverAttempts: 2,
		});
		insertRequest({
			id: "r3",
			comboName: "Main",
			timestamp: NOW,
			accountUsed: "acc-2",
			originalModel: "claude-sonnet-4-5",
			appliedModel: "glm-4.5",
			servedModel: "glm-4.5",
			success: true,
			responseTimeMs: 2000,
		});
		// Other combo — must not leak in.
		insertRequest({
			id: "r4",
			comboName: "Other",
			timestamp: NOW,
			accountUsed: "acc-1",
			success: true,
		});
		// Outside the window.
		insertRequest({
			id: "r5",
			comboName: "Main",
			timestamp: NOW - 25 * HOUR,
			accountUsed: "acc-1",
			success: true,
		});

		const data = await getFlow({
			combos: [combo("c1", "Main"), combo("c2", "Other")],
			accounts: ACCOUNTS,
		});
		const main = data.combos.find((c) => c.name === "Main")?.stats;
		expect(main?.requests).toBe(3);
		expect(main?.successRate).toBeCloseTo(2 / 3, 3);
		expect(main?.failoverRequests).toBe(1);
		expect(main?.avgResponseMs).toBe(2000);
		expect(main?.pairings[0]).toEqual({
			originalModel: "claude-sonnet-4-5",
			appliedModel: "glm-4.5",
			servedModel: "glm-4.5",
			account: "alpha",
			count: 2,
			successRate: 0.5,
		});
		expect(data.combos.find((c) => c.name === "Other")?.stats.requests).toBe(1);
	});

	it("reports a combo slot's pinned model as servedModel when no agent rewrite happened", async () => {
		// A combo slot override changes the request body but NOT
		// meta.originalModel/appliedModel (those are agent-rewrite only), so the
		// only column that reflects the pin is `model`, which the upstream
		// response populates. The matrix must still be able to show it.
		insertRequest({
			id: "s1",
			comboName: "Main",
			timestamp: NOW,
			accountUsed: "acc-1",
			servedModel: "claude-haiku-4-5-20251001",
			success: true,
		});

		const data = await getFlow({
			combos: [combo("c1", "Main")],
			accounts: ACCOUNTS,
		});
		const pairing = data.combos[0].stats.pairings[0];
		expect(pairing.servedModel).toBe("claude-haiku-4-5-20251001");
		expect(pairing.originalModel).toBeNull();
		expect(pairing.appliedModel).toBeNull();
	});

	it("keeps only the top 5 pairings, ordered by count", async () => {
		// Six distinct (appliedModel, account) buckets under one combo.
		const counts = [6, 5, 4, 3, 2, 1];
		counts.forEach((count, i) => {
			for (let j = 0; j < count; j++) {
				insertRequest({
					id: `r-${i}-${j}`,
					comboName: "Main",
					timestamp: NOW,
					accountUsed: "acc-1",
					originalModel: "claude-sonnet-4-5",
					appliedModel: `model-${i}`,
					success: true,
				});
			}
		});
		const data = await getFlow({
			combos: [combo("c1", "Main")],
			accounts: ACCOUNTS,
		});
		const pairings = data.combos[0].stats.pairings;
		expect(pairings).toHaveLength(5);
		expect(pairings.map((p) => p.appliedModel)).toEqual([
			"model-0",
			"model-1",
			"model-2",
			"model-3",
			"model-4",
		]);
		expect(pairings.map((p) => p.count)).toEqual([6, 5, 4, 3, 2]);
	});

	it("keeps only the top 3 error groups for the combo", async () => {
		const errors = [
			{
				status: 429,
				error: "rate limited",
				accountId: "acc-1",
				count: 5,
			},
			{
				status: 500,
				error: "boom",
				accountId: "acc-1",
				count: 4,
			},
			{
				status: 400,
				error: "bad request",
				accountId: "acc-1",
				count: 3,
			},
			{ status: 502, error: "bad gateway", count: 2 },
		];
		for (const e of errors) {
			for (let j = 0; j < e.count; j++) {
				insertRequest({
					id: `e-${e.status}-${j}`,
					comboName: "Main",
					timestamp: NOW,
					accountUsed: "acc-1",
					success: false,
					statusCode: e.status,
					errorMessage: e.error,
				});
			}
		}
		// A successful row must not appear in the error breakdown.
		insertRequest({
			id: "ok",
			comboName: "Main",
			timestamp: NOW,
			accountUsed: "acc-1",
			success: true,
		});

		const data = await getFlow({
			combos: [combo("c1", "Main")],
			accounts: ACCOUNTS,
		});
		expect(data.combos[0].stats.errorTop).toEqual([
			{
				status: 429,
				error: "rate limited",
				accountId: "acc-1",
				count: 5,
			},
			{
				status: 500,
				error: "boom",
				accountId: "acc-1",
				count: 4,
			},
			{
				status: 400,
				error: "bad request",
				accountId: "acc-1",
				count: 3,
			},
		]);
	});

	it("groups errors per account instead of blaming one account", async () => {
		// Same status + message from two accounts: these are two distinct
		// problem rows, not one row carrying a MIN()-picked account.
		for (let j = 0; j < 3; j++) {
			insertRequest({
				id: `e-a-${j}`,
				comboName: "Main",
				timestamp: NOW,
				accountUsed: "acc-1",
				success: false,
				statusCode: 429,
				errorMessage: "rate limited",
			});
		}
		for (let j = 0; j < 2; j++) {
			insertRequest({
				id: `e-b-${j}`,
				comboName: "Main",
				timestamp: NOW,
				accountUsed: "acc-2",
				success: false,
				statusCode: 429,
				errorMessage: "rate limited",
			});
		}
		const data = await getFlow({
			combos: [combo("c1", "Main")],
			accounts: ACCOUNTS,
		});
		expect(data.combos[0].stats.errorTop).toEqual([
			{
				status: 429,
				error: "rate limited",
				accountId: "acc-1",
				count: 3,
			},
			{
				status: 429,
				error: "rate limited",
				accountId: "acc-2",
				count: 2,
			},
		]);
	});

	it("returns the newest requests tagged with the combo, account names resolved", async () => {
		insertRequest({
			id: "old",
			comboName: "Main",
			timestamp: NOW - 60_000,
			accountUsed: "acc-1",
			originalModel: "claude-sonnet-4-5",
			servedModel: "glm-4.5",
			success: true,
			responseTimeMs: 900,
			failoverAttempts: 1,
		});
		insertRequest({
			id: "new",
			comboName: "Main",
			timestamp: NOW,
			accountUsed: "acc-2",
			originalModel: "claude-sonnet-4-5",
			appliedModel: "glm-4.5",
			success: false,
			statusCode: 500,
			errorMessage: "boom",
			responseTimeMs: 1200,
		});
		// Other combo and untagged rows must never leak into this list.
		insertRequest({
			id: "other",
			comboName: "Other",
			timestamp: NOW + 1,
			accountUsed: "acc-1",
			success: true,
		});

		const data = await getFlow({
			combos: [combo("c1", "Main"), combo("c2", "Other")],
			accounts: ACCOUNTS,
		});
		const recent = data.combos.find((c) => c.name === "Main")?.recentRequests;
		expect(recent?.map((r) => r.id)).toEqual(["new", "old"]);
		expect(recent?.[0]).toEqual({
			id: "new",
			timestamp: NOW,
			originalModel: "claude-sonnet-4-5",
			appliedModel: "glm-4.5",
			servedModel: null,
			account: "beta",
			statusCode: 500,
			success: false,
			failoverAttempts: 0,
			responseTimeMs: 1200,
		});
		expect(recent?.[1]).toMatchObject({
			servedModel: "glm-4.5",
			account: "alpha",
			success: true,
			failoverAttempts: 1,
		});
		// A combo with no rows gets an empty list without an extra query.
		expect(
			data.combos.find((c) => c.name === "Other")?.recentRequests,
		).toHaveLength(1);
	});

	it("returns an empty recent list for a combo with no rows", async () => {
		const data = await getFlow({
			combos: [combo("c1", "Main")],
			accounts: ACCOUNTS,
		});
		expect(data.combos[0].recentRequests).toEqual([]);
	});

	it("reports the routing switches and whether combo routing is active", async () => {
		const data = await getFlow(
			{ combos: [combo("c1", "Main")] },
			{},
			{
				getRoutingFlags: () => ({
					combosEnabled: true,
					forceAccountModel: true,
				}),
			},
		);
		expect(data.routing).toEqual({
			combosEnabled: true,
			forceAccountModel: true,
			comboRoutingActive: false,
		});
	});

	it("defaults to combo routing active when no flag reader is supplied", async () => {
		const data = await getFlow({ combos: [combo("c1", "Main")] });
		expect(data.routing).toEqual({
			combosEnabled: true,
			forceAccountModel: false,
			comboRoutingActive: true,
		});
	});

	it("surfaces the last observed order per family, or null when absent", async () => {
		const data = await getFlow(
			{
				combos: [combo("c1", "Main")],
				assignments: [{ family: "sonnet", combo_id: "c1", enabled: true }],
			},
			{
				sonnet: {
					family: "sonnet",
					order: [{ id: "acc-1", name: "alpha" }],
					model: "claude-sonnet-4-5",
					observedAtMs: NOW - 5000,
				},
			},
		);
		expect(
			data.families.find((f) => f.family === "sonnet")?.observation,
		).toEqual({
			model: "claude-sonnet-4-5",
			order: [{ id: "acc-1", name: "alpha" }],
			observedAtMs: NOW - 5000,
		});
		expect(
			data.families.find((f) => f.family === "opus")?.observation,
		).toBeNull();
	});
});
