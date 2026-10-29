import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	applyModelAndRouting,
	patchModelAndRouting,
	RequestBodyContext,
	resolveSlotRouting,
} from "../request-body-context";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "nanogpt",
		provider: "nanogpt",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
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
		consecutive_rate_limits: 0,
		...overrides,
	};
}

describe("routing capability with an account-aware provider", () => {
	// A host-aware adapter (NanoGPT on a third-party custom endpoint) answers
	// false for this account even though its provider name is in the core list.
	const customHostAccount = makeAccount({
		custom_endpoint: "https://gateway.example.com/v1",
	});

	it("applyModelAndRouting does not write provider when the capability says no", () => {
		const body: Record<string, unknown> = { model: "old" };
		applyModelAndRouting(body, "a/model-a", { only: ["a"] }, null, () => false);
		expect(body.model).toBe("a/model-a");
		expect(body.provider).toBeUndefined();
	});

	it("applyModelAndRouting removes a stale provider when the capability says no", () => {
		const body: Record<string, unknown> = {
			model: "old",
			provider: { only: ["stale"] },
		};
		applyModelAndRouting(
			body,
			"a/model-a",
			null,
			{ only: ["pin"] },
			() => false,
		);
		expect(body.provider).toBeUndefined();
	});

	it("applyModelAndRouting still writes provider when the capability says yes", () => {
		const body: Record<string, unknown> = { model: "old" };
		applyModelAndRouting(body, "a/model-a", { only: ["a"] }, null, () => true);
		expect(body.provider).toEqual({ only: ["a"] });
	});

	it("patchModelAndRouting does not write provider when the capability says no", () => {
		const encoded = new TextEncoder().encode(
			JSON.stringify({ model: "old", messages: [] }),
		);
		const buffer = encoded.buffer.slice(
			encoded.byteOffset,
			encoded.byteOffset + encoded.byteLength,
		) as ArrayBuffer;
		const patched = patchModelAndRouting(
			new RequestBodyContext(buffer),
			"a/model-a",
			{ only: ["a"] },
			{ only: ["pin"] },
			() => false,
		);
		const body = patched?.getParsedJson();
		expect(body?.model).toBe("a/model-a");
		expect(body?.provider).toBeUndefined();
	});

	it("resolveSlotRouting drops the slot pin on an unsupported account", () => {
		expect(
			resolveSlotRouting(customHostAccount, { only: ["a"] }, () => false),
		).toBeNull();
	});

	it("resolveSlotRouting keeps the slot pin when the capability says yes", () => {
		expect(
			resolveSlotRouting(makeAccount(), { only: ["a"] }, () => true),
		).toEqual({ only: ["a"] });
	});

	it("resolveSlotRouting falls back to the provider-name check without an instance", () => {
		expect(resolveSlotRouting(makeAccount(), { only: ["a"] })).toEqual({
			only: ["a"],
		});
		expect(resolveSlotRouting(customHostAccount, { only: ["a"] })).toEqual({
			only: ["a"],
		});
		expect(
			resolveSlotRouting(makeAccount({ provider: "anthropic" }), {
				only: ["a"],
			}),
		).toBeNull();
	});

	it("resolveSlotRouting passes null and routing through unchanged", () => {
		expect(resolveSlotRouting(customHostAccount, null, () => false)).toBeNull();
		expect(resolveSlotRouting(customHostAccount)).toBeNull();
	});
});
