import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { logBus } from "@better-ccflare/logger";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import { handleProxy } from "../../proxy";
import * as usageCollectorModule from "../../usage-collector";
import {
	getComboSlotInfo,
	selectAccountsForRequest,
} from "../account-selector";
import { resetModelCooldownsForTests } from "../model-cooldown";
import type { ProxyContext } from "../proxy-types";

const originalFetch = globalThis.fetch;

/**
 * Combo slots must stay index-aligned with the accounts they route to.
 *
 * proxy.ts resolves each account's model pin by POSITION (accounts[i] <->
 * slots[i]). The per-request provider exclusion header
 * (x-better-ccflare-exclude-providers) can drop slots from a request; when an
 * excluded slot precedes a surviving one, a positional consumer then pairs the
 * survivor with the wrong pin — or with none, after logging a
 * "Combo slot/account desync" error.
 */

const REQUEST_MODEL = "claude-sonnet-4-5";
const EXCLUDE_HEADER = "x-better-ccflare-exclude-providers";
const EXCLUDED_PROVIDER = "other-vendor";

/** A slot pin: the model the slot's operator configured for its account. */
function pinFor(accountId: string): string {
	return `pinned-model-${accountId}`;
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-a",
		name: "account-a",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	};
}

/** Accounts of two providers: `*-private` carries the excluded provider,
 * `*-shared` is a plain Anthropic OAuth account that always survives it. */
function mixedAccounts(): Account[] {
	return [
		makeAccount({ id: "acc-private-1", name: "private-one" }),
		makeAccount({ id: "acc-shared-1", name: "shared-one" }),
		makeAccount({ id: "acc-private-2", name: "private-two" }),
		makeAccount({ id: "acc-shared-2", name: "shared-two" }),
	].map((a) =>
		a.id.includes("private") ? { ...a, provider: EXCLUDED_PROVIDER } : a,
	);
}

function makeCombo(accountIds: string[]): ComboWithSlots {
	return {
		id: "combo-sonnet",
		name: "sonnet combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots: accountIds.map((accountId, priority) => ({
			id: `slot-${accountId}`,
			combo_id: "combo-sonnet",
			account_id: accountId,
			model: pinFor(accountId),
			priority,
			enabled: true,
		})),
	};
}

function makeContext(
	accounts: Account[],
	combo: ComboWithSlots | null,
): ProxyContext {
	return {
		strategy: { select: mock((all: Account[]) => all) } as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getCombosEnabled: () => true,
			getWebSearchEnabled: () => false,
			getWebSearchBypassHeader: () => true,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "exhausted",
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://upstream.invalid/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	};
}

function request(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			[EXCLUDE_HEADER]: EXCLUDED_PROVIDER,
		},
		body: JSON.stringify({
			model: REQUEST_MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function makeMeta(id: string): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers({ [EXCLUDE_HEADER]: EXCLUDED_PROVIDER }),
	};
}

/** The model the proxy actually sent upstream for a recorded fetch call. */
async function sentModel(call: unknown[]): Promise<string> {
	const input = call[0];
	let text: string | null = null;
	if (input instanceof Request) {
		text = await input.clone().text();
	} else {
		const init = call[1] as RequestInit | undefined;
		if (typeof init?.body === "string") text = init.body;
		else if (init?.body instanceof Uint8Array)
			text = new TextDecoder().decode(init.body);
		else if (init?.body instanceof ArrayBuffer)
			text = new TextDecoder().decode(new Uint8Array(init.body));
	}
	if (!text) return "";
	try {
		return (JSON.parse(text) as { model?: string }).model ?? "";
	} catch {
		return "";
	}
}

function successResponse(): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: REQUEST_MODEL,
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Run one request through handleProxy and return the outgoing model pins. */
async function runProxy(
	slotIds: string[],
): Promise<{ pins: string[]; status: number }> {
	const calls: unknown[][] = [];
	globalThis.fetch = mock(async (...args: unknown[]) => {
		calls.push(args);
		return successResponse();
	});
	const response = await handleProxy(
		request(),
		new URL("https://proxy.local/v1/messages"),
		makeContext(mixedAccounts(), makeCombo(slotIds)),
	);
	return {
		status: response.status,
		pins: await Promise.all(calls.map(sentModel)),
	};
}

describe("combo slots stay index-aligned with provider exclusions", () => {
	let messages: string[] = [];
	let listener: (event: { msg: string }) => void = () => {};

	beforeEach(() => {
		resetModelCooldownsForTests();
		usageCache.clear();
		messages = [];
		listener = (event) => messages.push(event.msg);
		logBus.on("log", listener);
		// forwardToClient feeds the process-wide UsageCollector on a 200; this
		// file never initialises the real one (same stub as
		// proxy-model-capacity.test.ts).
		const collector = {
			handleStart: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
			handleChunk: mock(() => {}),
		} as unknown as usageCollectorModule.UsageCollector;
		spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue(collector);
		spyOn(usageCollectorModule, "tryGetUsageCollector").mockReturnValue(
			collector,
		);
	});

	afterEach(() => {
		logBus.off("log", listener);
		globalThis.fetch = originalFetch;
		mock.restore();
		resetModelCooldownsForTests();
		usageCache.clear();
	});

	it("routes the survivor of an excluded FIRST slot under its own pin, with no desync error", async () => {
		// The first slot is excluded, two survivors follow. Any positional
		// misalignment lands on the second survivor, which a failover would
		// answer for; the selector is asserted first so a desync can't hide
		// behind a fallback.
		const meta = makeMeta("req-first-excluded");
		const ctx = makeContext(
			mixedAccounts(),
			makeCombo(["acc-private-1", "acc-shared-1", "acc-shared-2"]),
		);
		const returned = await selectAccountsForRequest(meta, ctx, REQUEST_MODEL);
		const info = getComboSlotInfo(meta);

		expect(returned.map((a) => a.id)).toEqual(["acc-shared-1", "acc-shared-2"]);
		// The pin each account is asked under, exactly as proxy.ts resolves it.
		const pins = returned.map((_a, i) => {
			const slot = info?.slots[i];
			return slot?.accountId === returned[i].id ? slot.modelOverride : null;
		});
		expect(pins).toEqual([pinFor("acc-shared-1"), pinFor("acc-shared-2")]);

		// End to end: the first survivor goes upstream under its own pin.
		const calls: unknown[][] = [];
		globalThis.fetch = mock(async (...args: unknown[]) => {
			calls.push(args);
			return successResponse();
		});
		const response = await handleProxy(
			request(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(response.status).toBe(200);
		expect(await Promise.all(calls.map(sentModel))).toEqual([
			pinFor("acc-shared-1"),
		]);
	});

	it("keeps behaviour unchanged when the excluded slot is LAST", async () => {
		const { pins, status } = await runProxy(["acc-shared-1", "acc-private-1"]);

		expect(status).toBe(200);
		expect(pins).toEqual([pinFor("acc-shared-1")]);
		expect(
			messages.filter((m) => m.includes("Combo slot/account desync")),
		).toEqual([]);
	});

	it("gives each survivor its own pin when two exclusions interleave with two survivors", async () => {
		const meta = makeMeta("req-interleaved");
		const returned = await selectAccountsForRequest(
			meta,
			makeContext(
				mixedAccounts(),
				makeCombo([
					"acc-private-1",
					"acc-shared-1",
					"acc-private-2",
					"acc-shared-2",
				]),
			),
			REQUEST_MODEL,
		);
		const info = getComboSlotInfo(meta);

		expect(returned.map((a) => a.id)).toEqual(["acc-shared-1", "acc-shared-2"]);
		expect(info?.slots).toEqual([
			{ accountId: "acc-shared-1", modelOverride: pinFor("acc-shared-1") },
			{ accountId: "acc-shared-2", modelOverride: pinFor("acc-shared-2") },
		]);
		// What proxy.ts does: pair returned[i] with slots[i] and take its pin.
		expect(returned.map((_a, i) => info?.slots[i]?.modelOverride)).toEqual([
			pinFor("acc-shared-1"),
			pinFor("acc-shared-2"),
		]);
	});

	it("falls through to normal routing when every slot is excluded", async () => {
		const meta = makeMeta("req-all-excluded");
		const returned = await selectAccountsForRequest(
			meta,
			makeContext(
				mixedAccounts(),
				makeCombo(["acc-private-1", "acc-private-2"]),
			),
			REQUEST_MODEL,
		);

		// Normal pool routing: the surviving pool accounts, no combo state.
		expect(returned.map((a) => a.id)).toEqual(["acc-shared-1", "acc-shared-2"]);
		expect(getComboSlotInfo(meta)).toBeNull();
		expect(meta.comboName).toBeUndefined();
		expect(messages).toContain(
			"All 2 combo slots unavailable for sonnet combo, falling back to SessionStrategy",
		);
	});

	it("records slots equal in length to, and index-aligned with, the returned accounts", async () => {
		const accounts = mixedAccounts();
		const cases: Array<{ slots: string[]; expected: string[] }> = [
			{ slots: ["acc-private-1", "acc-shared-1"], expected: ["acc-shared-1"] },
			{
				slots: [
					"acc-private-1",
					"acc-shared-1",
					"acc-private-2",
					"acc-shared-2",
				],
				expected: ["acc-shared-1", "acc-shared-2"],
			},
			{ slots: ["acc-shared-1", "acc-private-1"], expected: ["acc-shared-1"] },
			{
				slots: ["acc-shared-1", "acc-shared-2"],
				expected: ["acc-shared-1", "acc-shared-2"],
			},
		];
		for (const { slots, expected } of cases) {
			const meta = makeMeta(`req-${slots.join("-")}`);
			const returned = await selectAccountsForRequest(
				meta,
				makeContext(accounts, makeCombo(slots)),
				REQUEST_MODEL,
			);
			const info = getComboSlotInfo(meta);
			expect(returned.map((a) => a.id)).toEqual(expected);
			expect(info?.slots).toHaveLength(returned.length);
			expect(info?.slots.map((s) => s.accountId)).toEqual(
				returned.map((a) => a.id),
			);
		}
	});

	// The exclusion membership set is resolved over the WHOLE fleet (that is what
	// makes the slot list index-aligned), so it must not reuse `applyExclusions`'
	// warning, which counts the list it was handed. A combo whose slots are all
	// permitted used to log fleet-wide exclusions on every request.
	it("does not warn about excluded accounts that were never combo candidates", async () => {
		const meta = makeMeta("req-no-excluded-slots");
		const returned = await selectAccountsForRequest(
			meta,
			// The fleet still holds two excluded-provider accounts; the combo uses
			// neither.
			makeContext(mixedAccounts(), makeCombo(["acc-shared-1", "acc-shared-2"])),
			REQUEST_MODEL,
		);

		expect(returned.map((a) => a.id)).toEqual(["acc-shared-1", "acc-shared-2"]);
		expect(
			messages.filter((m) => m.includes("excluded for this request type")),
		).toEqual([]);
	});

	it("warns once, counting only the combo slots it actually skipped", async () => {
		const meta = makeMeta("req-one-excluded-slot");
		const returned = await selectAccountsForRequest(
			meta,
			// One excluded slot, plus an excluded account that is not a combo
			// candidate at all: the count must be 1 slot, not 2 accounts.
			makeContext(
				mixedAccounts(),
				makeCombo(["acc-private-1", "acc-shared-1"]),
			),
			REQUEST_MODEL,
		);

		expect(returned.map((a) => a.id)).toEqual(["acc-shared-1"]);
		const warnings = messages.filter((m) =>
			m.includes("excluded for this request type"),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Skipping 1 combo slot(s)");
	});
});
