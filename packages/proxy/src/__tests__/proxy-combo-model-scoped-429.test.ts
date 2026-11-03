import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	isModelCooling,
	resetModelCooldownsForTests,
} from "../handlers/model-cooldown";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

const originalFetch = globalThis.fetch;

/**
 * End-to-end proof of the CodeBuddy free→paid scenario this change exists for:
 * one account serves a free model and a paid model as two COMBO SLOTS. The
 * free slot 429s on its quota; the request must still be served by the paid
 * slot on the SAME account, and the account must NOT be benched — otherwise
 * every later request skips the account entirely and the paid slot becomes
 * unreachable until the quota window resets.
 *
 * Unit-level halves of this behaviour live in:
 *  - packages/proxy/src/handlers/__tests__/proxy-operations-combo-model-cooldown.test.ts
 *  - packages/proxy/src/handlers/__tests__/account-selector-model-cooldown.test.ts
 */

const FREE_MODEL = "deepseek-v4.1-flash";
const PAID_MODEL = "deepseek-v4.1-flash-sg";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-cb",
		name: "codebuddy",
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
		consecutive_rate_limits: 0,
		rate_limited_at: null,
		rate_limited_reason: null,
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

function makeCombo(slots: ComboWithSlots["slots"]): ComboWithSlots {
	return {
		id: "combo-sonnet",
		name: "sonnet",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots,
	};
}

function makeContext(account: Account, combo: ComboWithSlots): ProxyContext {
	return {
		strategy: { select: mock((accounts: Account[]) => accounts) } as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
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
			buildUrl: () => "https://api.anthropic.com/v1/messages",
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

/** Quota 429 shaped like CodeBuddy's 6004 body (names a future reset). */
function quota429Response(): Response {
	return new Response(
		JSON.stringify({
			code: 6004,
			msg: "您的使用量已超出频率限制，将在 2026-11-03 18:20:40 UTC+8 重置",
		}),
		{
			status: 429,
			headers: { "content-type": "application/json" },
		},
	);
}

function successResponse(model: string): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model,
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function request(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

/** The model the proxy actually sent upstream for a recorded fetch call. */
async function sentModel(call: unknown[]): Promise<string> {
	const input = call[0];
	const init = call[1] as RequestInit | undefined;
	let text: string | null = null;
	if (input instanceof Request) {
		text = await input.clone().text();
	} else if (typeof init?.body === "string") {
		text = init.body;
	} else if (init?.body instanceof Uint8Array) {
		text = new TextDecoder().decode(init.body);
	} else if (init?.body instanceof ArrayBuffer) {
		text = new TextDecoder().decode(new Uint8Array(init.body));
	}
	if (!text) return "";
	try {
		return (JSON.parse(text) as { model?: string }).model ?? "";
	} catch {
		return "";
	}
}

describe("handleProxy combo 429 — free slot must not bench the account's paid slot", () => {
	let account: Account;
	const calls: unknown[][] = [];

	beforeEach(() => {
		resetModelCooldownsForTests();
		usageCache.clear();
		calls.length = 0;
		account = makeAccount();
		// forwardToClient feeds the process-wide UsageCollector on a 200; this
		// narrower test file never initialises the real one (same stub as
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
		globalThis.fetch = originalFetch;
		mock.restore();
		resetModelCooldownsForTests();
		usageCache.clear();
	});

	const combo = makeCombo([
		{
			id: "slot-free",
			combo_id: "combo-sonnet",
			account_id: "acc-cb",
			model: FREE_MODEL,
			priority: 0,
			enabled: true,
		},
		{
			id: "slot-paid",
			combo_id: "combo-sonnet",
			account_id: "acc-cb",
			model: PAID_MODEL,
			priority: 1,
			enabled: true,
		},
	]);

	it("serves the paid slot in the same request and leaves the account unbenched", async () => {
		// Free model is over quota; the paid model still works.
		globalThis.fetch = mock(async (...args: unknown[]) => {
			calls.push(args);
			const model = await sentModel(args);
			return model === FREE_MODEL ? quota429Response() : successResponse(model);
		});

		const response = await handleProxy(
			request(),
			new URL("https://proxy.local/v1/messages"),
			makeContext(account, combo),
		);

		// Served by the paid slot after the free slot 429'd.
		expect(response.status).toBe(200);
		expect(await Promise.all(calls.map(sentModel))).toEqual([
			FREE_MODEL,
			PAID_MODEL,
		]);

		// The account is NOT benched...
		expect(account.rate_limited_until).toBeNull();
		// ...but the free MODEL is cooling, so later requests skip that slot.
		expect(isModelCooling(account.id, FREE_MODEL)).toBe(true);
	});

	it("routes the next request straight to the paid slot — no repeated free-model 429", async () => {
		globalThis.fetch = mock(async (...args: unknown[]) => {
			calls.push(args);
			const model = await sentModel(args);
			return model === FREE_MODEL ? quota429Response() : successResponse(model);
		});

		const context = makeContext(account, combo);
		await handleProxy(
			request(),
			new URL("https://proxy.local/v1/messages"),
			context,
		);
		expect(isModelCooling(account.id, FREE_MODEL)).toBe(true);

		// Second request: the free slot is in cooldown, so selection yields only
		// the paid slot — exactly one upstream call, straight to the paid model.
		calls.length = 0;
		const response = await handleProxy(
			request(),
			new URL("https://proxy.local/v1/messages"),
			context,
		);

		expect(response.status).toBe(200);
		expect(await Promise.all(calls.map(sentModel))).toEqual([PAID_MODEL]);
		expect(account.rate_limited_until).toBeNull();
	});
});
