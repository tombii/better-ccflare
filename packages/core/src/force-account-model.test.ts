import { afterEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	isForceAccountModelEnabled,
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
