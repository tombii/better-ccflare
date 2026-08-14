import { afterEach, describe, expect, it } from "bun:test";
import { setForceAccountModel } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { getModelName } from "./model-mapping";

// getModelName is a sibling of core's mapModelName, reached only by the
// vertex-ai provider. It was the one mapping path left unguarded when "force
// account model" landed, which would have made the setting's promise false for
// exactly one provider — the kind of gap nobody notices until someone with a
// Vertex account reports that their model still gets rewritten.

function makeAccount(): Account {
	return {
		id: "acc-1",
		name: "vertex-account",
		provider: "vertex-ai",
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
		model_mappings: JSON.stringify({ opus: "gemini-2.5-pro" }),
		cross_region_mode: null,
		model_fallbacks: null,
	};
}

afterEach(() => {
	setForceAccountModel(false);
});

describe("getModelName under force account model", () => {
	it("maps as usual while the setting is off", () => {
		expect(getModelName("claude-opus-4-1", makeAccount())).toBe(
			"gemini-2.5-pro",
		);
	});

	it("returns the model untouched while the setting is on", () => {
		setForceAccountModel(true);
		expect(getModelName("claude-opus-4-1", makeAccount())).toBe(
			"claude-opus-4-1",
		);
	});

	it("is unaffected for an account with no mappings either way", () => {
		const account = { ...makeAccount(), model_mappings: null };
		expect(getModelName("gemini-2.5-pro", account)).toBe("gemini-2.5-pro");
		setForceAccountModel(true);
		expect(getModelName("gemini-2.5-pro", account)).toBe("gemini-2.5-pro");
	});
});
