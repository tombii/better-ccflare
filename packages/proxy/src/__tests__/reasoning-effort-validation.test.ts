/**
 * An invalid `reasoning.effort` is a client error, not a routing failure.
 *
 * The provider transform throws ValidationError for it inside each account
 * attempt, so without the pre-flight check the proxy retries every account and
 * answers 503 "all accounts failed" for what is plainly a bad request. The
 * documented contract is 400 invalid_request_error, and no account (or
 * upstream) should be consulted to produce it.
 */
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
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

function makeContext(getAllAccounts: () => Promise<Account[]>): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => accs,
		} as never,
		dbOps: {
			getAllAccounts: mock(getAllAccounts),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getWebSearchEnabled: () => false,
			getWebSearchBypassHeader: () => true,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getForceAccountModel: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

function makeRequest(reasoning?: Record<string, unknown>): Request {
	const body: Record<string, unknown> = {
		model: "claude-sonnet-4-5",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 16,
	};
	if (reasoning !== undefined) body.reasoning = reasoning;
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	usageCache.clear();
	stubUsageCollector();
});

afterEach(() => {
	usageCache.clear();
});

describe("/v1/messages reasoning.effort validation", () => {
	it("answers 400 invalid_request_error for an invalid effort without consulting an account", async () => {
		const getAllAccounts = mock(async () => [] as Account[]);
		const ctx = makeContext(getAllAccounts);

		const response = await handleProxy(
			makeRequest({ effort: "extreme" }),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			error: { type: string; message: string };
		};
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toContain("reasoning.effort must be one of");
		expect(getAllAccounts).not.toHaveBeenCalled();
	});

	it("lets a valid effort through to the normal routing path", async () => {
		const getAllAccounts = mock(async () => [] as Account[]);
		const ctx = makeContext(getAllAccounts);

		const response = await handleProxy(
			makeRequest({ effort: "high" }),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).not.toBe(400);
		expect(getAllAccounts).toHaveBeenCalled();
	});
});
