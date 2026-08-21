import { afterEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	isForceAccountModelEnabled,
	isForceAccountModelExempt,
	runForceAccountModelExempt,
	setForceAccountModel,
} from "./force-account-model";
import { mapModelName, providerAcceptsClientModel } from "./model-mappings";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
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
		model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	};
}

afterEach(() => {
	setForceAccountModel(false);
});

describe("force account model", () => {
	it("is off until something turns it on", () => {
		expect(isForceAccountModelEnabled()).toBe(false);
	});

	it("keeps mapping models while off", () => {
		expect(mapModelName("claude-opus-4-1", makeAccount())).toBe("gpt-5.6-sol");
	});

	it("stops every rename while on, including an explicit account mapping", () => {
		setForceAccountModel(true);
		// The account asked for this rewrite and it is still refused: with the
		// setting on, selection has already guaranteed the account can serve the
		// model as written, so renaming here could only undo that guarantee.
		expect(mapModelName("claude-opus-4-1", makeAccount())).toBe(
			"claude-opus-4-1",
		);
	});

	it("leaves a model with no mapping alone either way", () => {
		const account = makeAccount({ model_mappings: null });
		expect(mapModelName("gpt-5.6-sol", account)).toBe("gpt-5.6-sol");
		setForceAccountModel(true);
		expect(mapModelName("gpt-5.6-sol", account)).toBe("gpt-5.6-sol");
	});
});

describe("providerAcceptsClientModel", () => {
	it("is true only for providers whose upstream speaks Claude model ids", () => {
		expect(providerAcceptsClientModel("anthropic")).toBe(true);
		expect(providerAcceptsClientModel("claude-console-api")).toBe(true);
		expect(providerAcceptsClientModel("codex")).toBe(false);
		expect(providerAcceptsClientModel("zai")).toBe(false);
	});

	it("treats a missing provider as anthropic, matching the rest of the codebase", () => {
		expect(providerAcceptsClientModel(null)).toBe(true);
		expect(providerAcceptsClientModel(undefined)).toBe(true);
	});
});

/**
 * The exempt scope exists for better-ccflare's own probes. A probe names a
 * compiled-in Claude model for whatever account it is aimed at, so mapping is
 * what makes it land — suppressing mapping there breaks the probe instead of
 * honouring a promise about client requests.
 */
describe("force account model — internal-probe exemption scope", () => {
	it("reads as off inside the scope and on again outside it", () => {
		setForceAccountModel(true);

		expect(isForceAccountModelEnabled()).toBe(true);
		runForceAccountModelExempt(() => {
			expect(isForceAccountModelEnabled()).toBe(false);
			expect(isForceAccountModelExempt()).toBe(true);
		});
		expect(isForceAccountModelEnabled()).toBe(true);
		expect(isForceAccountModelExempt()).toBe(false);
	});

	it("lets mapping happen again inside the scope", () => {
		setForceAccountModel(true);
		const account = makeAccount();

		expect(mapModelName("claude-opus-4-1", account)).toBe("claude-opus-4-1");
		runForceAccountModelExempt(() => {
			// This is the whole point: without it the probe's Claude id reaches a
			// Codex account untranslated and comes back as a refresh failure.
			expect(mapModelName("claude-opus-4-1", account)).toBe("gpt-5.6-sol");
		});
	});

	it("survives awaits, so a mapping deep in the request still sees it", async () => {
		setForceAccountModel(true);

		await runForceAccountModelExempt(async () => {
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(isForceAccountModelEnabled()).toBe(false);
			expect(mapModelName("claude-opus-4-1", makeAccount())).toBe(
				"gpt-5.6-sol",
			);
		});

		expect(isForceAccountModelEnabled()).toBe(true);
	});

	it("does not leak into a concurrent request that is not a probe", async () => {
		setForceAccountModel(true);
		const account = makeAccount();
		const seen: string[] = [];

		// Interleaved on purpose: a scope that leaked across async boundaries
		// would let one probe disable the operator's setting for real traffic
		// that happens to be in flight beside it.
		const probe = runForceAccountModelExempt(async () => {
			await new Promise((resolve) => setTimeout(resolve, 2));
			seen.push(`probe:${mapModelName("claude-opus-4-1", account)}`);
		});
		const client = (async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			seen.push(`client:${mapModelName("claude-opus-4-1", account)}`);
		})();

		await Promise.all([probe, client]);

		expect(seen.sort()).toEqual([
			"client:claude-opus-4-1",
			"probe:gpt-5.6-sol",
		]);
	});

	it("is off by default, so nothing is exempt until a scope opens", () => {
		expect(isForceAccountModelExempt()).toBe(false);
	});
});
