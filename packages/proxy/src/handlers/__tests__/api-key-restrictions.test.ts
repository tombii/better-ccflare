import { describe, expect, it } from "bun:test";
import type {
	Account,
	ApiKeyRestrictions,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getApiKeyRestrictionDenial,
	isAccountAllowedForApiKey,
	isModelAllowedForApiKey,
	restrictsAccountPool,
	restrictsModels,
	setApiKeyRestrictionDenial,
	summarizeAccountRestrictionScope,
} from "../api-key-restrictions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
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
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	} as unknown as Account;
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeRestrictions(
	overrides: Partial<ApiKeyRestrictions> = {},
): ApiKeyRestrictions {
	return {
		allowedAccounts: null,
		allowedModels: null,
		allowedProviders: null,
		...overrides,
	};
}

// ── restrictsAccountPool / restrictsModels ────────────────────────────────────

describe("restrictsAccountPool / restrictsModels", () => {
	it("treats a missing restriction object as unrestricted", () => {
		expect(restrictsAccountPool(null)).toBe(false);
		expect(restrictsAccountPool(undefined)).toBe(false);
		expect(restrictsModels(null)).toBe(false);
		expect(restrictsModels(undefined)).toBe(false);
	});

	it("treats an all-null restriction object as unrestricted", () => {
		const restrictions = makeRestrictions();
		expect(restrictsAccountPool(restrictions)).toBe(false);
		expect(restrictsModels(restrictions)).toBe(false);
	});

	it("treats an empty array as a restriction, not as absence of one", () => {
		expect(
			restrictsAccountPool(makeRestrictions({ allowedAccounts: [] })),
		).toBe(true);
		expect(
			restrictsAccountPool(makeRestrictions({ allowedProviders: [] })),
		).toBe(true);
		expect(restrictsModels(makeRestrictions({ allowedModels: [] }))).toBe(true);
	});

	it("keeps the model allowlist out of the account-pool predicate", () => {
		const restrictions = makeRestrictions({ allowedModels: ["opus"] });
		expect(restrictsAccountPool(restrictions)).toBe(false);
		expect(restrictsModels(restrictions)).toBe(true);
	});
});

// ── isAccountAllowedForApiKey ─────────────────────────────────────────────────

describe("isAccountAllowedForApiKey", () => {
	it("allows every account for an unrestricted key", () => {
		const account = makeAccount();
		expect(isAccountAllowedForApiKey(account, null)).toBe(true);
		expect(isAccountAllowedForApiKey(account, undefined)).toBe(true);
		expect(isAccountAllowedForApiKey(account, makeRestrictions())).toBe(true);
	});

	it("allows only accounts named in allowedAccounts", () => {
		const restrictions = makeRestrictions({
			allowedAccounts: ["acc-1", "acc-3"],
		});
		expect(
			isAccountAllowedForApiKey(makeAccount({ id: "acc-1" }), restrictions),
		).toBe(true);
		expect(
			isAccountAllowedForApiKey(makeAccount({ id: "acc-2" }), restrictions),
		).toBe(false);
		expect(
			isAccountAllowedForApiKey(makeAccount({ id: "acc-3" }), restrictions),
		).toBe(true);
	});

	it("denies every account when allowedAccounts is an empty array", () => {
		const restrictions = makeRestrictions({ allowedAccounts: [] });
		expect(isAccountAllowedForApiKey(makeAccount(), restrictions)).toBe(false);
	});

	it("matches a dangling account id against nothing (deleted account)", () => {
		const restrictions = makeRestrictions({
			allowedAccounts: ["acc-deleted"],
		});
		expect(
			isAccountAllowedForApiKey(makeAccount({ id: "acc-1" }), restrictions),
		).toBe(false);
	});

	it("allows only providers named in allowedProviders", () => {
		const restrictions = makeRestrictions({ allowedProviders: ["zai"] });
		expect(
			isAccountAllowedForApiKey(makeAccount({ provider: "zai" }), restrictions),
		).toBe(true);
		expect(
			isAccountAllowedForApiKey(
				makeAccount({ provider: "anthropic" }),
				restrictions,
			),
		).toBe(false);
	});

	it("denies every account when allowedProviders is an empty array", () => {
		const restrictions = makeRestrictions({ allowedProviders: [] });
		expect(isAccountAllowedForApiKey(makeAccount(), restrictions)).toBe(false);
	});

	it("treats a missing provider as anthropic", () => {
		const account = makeAccount({ provider: undefined });
		expect(
			isAccountAllowedForApiKey(
				account,
				makeRestrictions({ allowedProviders: ["anthropic"] }),
			),
		).toBe(true);
		expect(
			isAccountAllowedForApiKey(
				account,
				makeRestrictions({ allowedProviders: ["zai"] }),
			),
		).toBe(false);
	});

	it("requires BOTH lists to allow the account when both are set", () => {
		const restrictions = makeRestrictions({
			allowedAccounts: ["acc-1"],
			allowedProviders: ["zai"],
		});
		// Right id, wrong provider.
		expect(
			isAccountAllowedForApiKey(
				makeAccount({ id: "acc-1", provider: "anthropic" }),
				restrictions,
			),
		).toBe(false);
		// Right provider, wrong id.
		expect(
			isAccountAllowedForApiKey(
				makeAccount({ id: "acc-2", provider: "zai" }),
				restrictions,
			),
		).toBe(false);
		// Both right.
		expect(
			isAccountAllowedForApiKey(
				makeAccount({ id: "acc-1", provider: "zai" }),
				restrictions,
			),
		).toBe(true);
	});
});

// ── isModelAllowedForApiKey ───────────────────────────────────────────────────

describe("isModelAllowedForApiKey", () => {
	it("allows any model for an unrestricted key", () => {
		expect(isModelAllowedForApiKey("claude-opus-4-8", null)).toBe(true);
		expect(isModelAllowedForApiKey("claude-opus-4-8", makeRestrictions())).toBe(
			true,
		);
	});

	it("allows an exact model id match", () => {
		const restrictions = makeRestrictions({
			allowedModels: ["claude-opus-4-8"],
		});
		expect(isModelAllowedForApiKey("claude-opus-4-8", restrictions)).toBe(true);
	});

	it("does NOT let one exact model id stand in for its whole family", () => {
		const restrictions = makeRestrictions({
			allowedModels: ["claude-opus-4-8"],
		});
		expect(isModelAllowedForApiKey("claude-opus-4-5", restrictions)).toBe(
			false,
		);
	});

	it("allows every model of a family when the family name is listed", () => {
		const restrictions = makeRestrictions({ allowedModels: ["opus"] });
		expect(isModelAllowedForApiKey("claude-opus-4-8", restrictions)).toBe(true);
		expect(
			isModelAllowedForApiKey("claude-opus-4-1-20250805", restrictions),
		).toBe(true);
		expect(isModelAllowedForApiKey("claude-sonnet-4-5", restrictions)).toBe(
			false,
		);
	});

	it("matches model ids case-insensitively", () => {
		const restrictions = makeRestrictions({
			allowedModels: ["Claude-Opus-4-8"],
		});
		expect(isModelAllowedForApiKey("claude-opus-4-8", restrictions)).toBe(true);
	});

	it("denies every model when allowedModels is an empty array", () => {
		const restrictions = makeRestrictions({ allowedModels: [] });
		expect(isModelAllowedForApiKey("claude-opus-4-8", restrictions)).toBe(
			false,
		);
	});

	it("denies a non-Claude model that matches no entry", () => {
		const restrictions = makeRestrictions({ allowedModels: ["opus"] });
		expect(isModelAllowedForApiKey("z-ai/glm-4.5-air:free", restrictions)).toBe(
			false,
		);
	});

	it("allows a non-Claude model listed exactly", () => {
		const restrictions = makeRestrictions({
			allowedModels: ["z-ai/glm-4.5-air:free"],
		});
		expect(isModelAllowedForApiKey("z-ai/glm-4.5-air:free", restrictions)).toBe(
			true,
		);
	});

	it("does not evaluate a request that names no model", () => {
		// A model allowlist governs the model a client asks for. A request that
		// names none cannot violate it; the account/provider lists still apply.
		const restrictions = makeRestrictions({ allowedModels: [] });
		expect(isModelAllowedForApiKey(null, restrictions)).toBe(true);
		expect(isModelAllowedForApiKey(undefined, restrictions)).toBe(true);
		expect(isModelAllowedForApiKey("", restrictions)).toBe(true);
	});
});

// ── summarizeAccountRestrictionScope ──────────────────────────────────────────

describe("summarizeAccountRestrictionScope", () => {
	it("names which list is doing the restricting", () => {
		expect(
			summarizeAccountRestrictionScope(
				makeRestrictions({ allowedAccounts: ["a"] }),
			),
		).toBe("accounts");
		expect(
			summarizeAccountRestrictionScope(
				makeRestrictions({ allowedProviders: ["zai"] }),
			),
		).toBe("providers");
		expect(
			summarizeAccountRestrictionScope(
				makeRestrictions({ allowedAccounts: ["a"], allowedProviders: ["zai"] }),
			),
		).toBe("accounts and providers");
	});
});

// ── denial side channel ───────────────────────────────────────────────────────

describe("setApiKeyRestrictionDenial / getApiKeyRestrictionDenial", () => {
	it("stores and retrieves a denial on a RequestMeta", () => {
		const meta = makeRequestMeta();
		setApiKeyRestrictionDenial(meta, { scope: "accounts", removed: 3 });
		expect(getApiKeyRestrictionDenial(meta)).toEqual({
			scope: "accounts",
			removed: 3,
		});
	});

	it("returns null for a meta that was never set", () => {
		expect(getApiKeyRestrictionDenial(makeRequestMeta())).toBeNull();
	});

	it("is isolated per RequestMeta object (WeakMap semantics)", () => {
		const first = makeRequestMeta();
		const second = makeRequestMeta();
		setApiKeyRestrictionDenial(first, { scope: "providers", removed: 1 });
		expect(getApiKeyRestrictionDenial(second)).toBeNull();
	});
});
