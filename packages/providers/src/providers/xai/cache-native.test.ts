import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	applyXaiConvIdHeader,
	deriveXaiConvId,
	isOfficialXaiEndpoint,
	isValidSessionId,
	isXaiCacheNativeEnabled,
	XAI_CACHE_NATIVE_ENV,
	XAI_CONV_ID_HEADER,
} from "./cache-native";

const VALID_SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER_SESSION_ID = "11111111-2222-4333-8444-555555555555";

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "xai-1",
		name: "xai-test",
		provider: "xai",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60_000,
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
		priority: 50,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
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

const enabledEnv = {
	[XAI_CACHE_NATIVE_ENV]: "1",
} as unknown as NodeJS.ProcessEnv;
const disabledEnv = {} as NodeJS.ProcessEnv;

describe("constants", () => {
	it("uses the official xAI Chat Completions affinity header name", () => {
		expect(XAI_CONV_ID_HEADER).toBe("x-grok-conv-id");
	});

	it("uses CCFLARE_XAI_CACHE_NATIVE as the opt-in env var", () => {
		expect(XAI_CACHE_NATIVE_ENV).toBe("CCFLARE_XAI_CACHE_NATIVE");
	});
});

describe("isXaiCacheNativeEnabled", () => {
	it("is disabled by default (no env var set)", () => {
		expect(isXaiCacheNativeEnabled(disabledEnv)).toBe(false);
	});

	it("is enabled only for the exact string '1'", () => {
		expect(isXaiCacheNativeEnabled(enabledEnv)).toBe(true);
		expect(
			isXaiCacheNativeEnabled({
				[XAI_CACHE_NATIVE_ENV]: "true",
			} as unknown as NodeJS.ProcessEnv),
		).toBe(false);
		expect(
			isXaiCacheNativeEnabled({
				[XAI_CACHE_NATIVE_ENV]: "yes",
			} as unknown as NodeJS.ProcessEnv),
		).toBe(false);
		expect(
			isXaiCacheNativeEnabled({
				[XAI_CACHE_NATIVE_ENV]: "0",
			} as unknown as NodeJS.ProcessEnv),
		).toBe(false);
		expect(
			isXaiCacheNativeEnabled({
				[XAI_CACHE_NATIVE_ENV]: "",
			} as unknown as NodeJS.ProcessEnv),
		).toBe(false);
	});
});

describe("isValidSessionId", () => {
	it("accepts a well-formed session UUID", () => {
		expect(isValidSessionId(VALID_SESSION_ID)).toBe(true);
	});

	it("accepts uppercase UUIDs", () => {
		expect(isValidSessionId(VALID_SESSION_ID.toUpperCase())).toBe(true);
	});

	it("rejects junk, empty, and non-UUID-shaped input", () => {
		expect(isValidSessionId("not-a-uuid")).toBe(false);
		expect(isValidSessionId("")).toBe(false);
		expect(isValidSessionId(null)).toBe(false);
		expect(isValidSessionId(undefined)).toBe(false);
		expect(isValidSessionId("3fa85f6457174562b3fc2c963f66afa6")).toBe(false); // no dashes
		expect(isValidSessionId("'; DROP TABLE accounts; --")).toBe(false);
		expect(isValidSessionId("00000000-0000-0000-0000-000000000000")).toBe(
			false,
		); // version nibble 0 is out of range
	});
});

describe("isOfficialXaiEndpoint", () => {
	it("is official for a bare xai account with no custom endpoint", () => {
		expect(isOfficialXaiEndpoint(account())).toBe(true);
	});

	it("is official for an account explicitly pointed at api.x.ai", () => {
		expect(
			isOfficialXaiEndpoint(
				account({ custom_endpoint: "https://api.x.ai/v1" }),
			),
		).toBe(true);
	});

	it("is NOT official for a custom/proxy endpoint", () => {
		expect(
			isOfficialXaiEndpoint(
				account({ custom_endpoint: "https://my-proxy.example.com/v1" }),
			),
		).toBe(false);
	});

	it("is NOT official for a non-xai provider account", () => {
		expect(isOfficialXaiEndpoint(account({ provider: "anthropic" }))).toBe(
			false,
		);
	});

	it("treats a missing account as targeting the official default endpoint", () => {
		expect(isOfficialXaiEndpoint(null)).toBe(true);
		expect(isOfficialXaiEndpoint(undefined)).toBe(true);
	});
});

describe("deriveXaiConvId — gating", () => {
	it("returns null when the feature flag is off, even with a valid session id", () => {
		expect(deriveXaiConvId(VALID_SESSION_ID, disabledEnv)).toBeNull();
	});

	it("returns null for a missing session id even when enabled", () => {
		expect(deriveXaiConvId(null, enabledEnv)).toBeNull();
		expect(deriveXaiConvId(undefined, enabledEnv)).toBeNull();
	});

	it("returns null for a malformed session id even when enabled", () => {
		expect(deriveXaiConvId("not-a-uuid", enabledEnv)).toBeNull();
		expect(deriveXaiConvId("", enabledEnv)).toBeNull();
	});
});

describe("deriveXaiConvId — privacy-safe derivation", () => {
	it("derives a non-null id for a valid session id when enabled", () => {
		expect(deriveXaiConvId(VALID_SESSION_ID, enabledEnv)).not.toBeNull();
	});

	it("is stable for the same session id", () => {
		const a = deriveXaiConvId(VALID_SESSION_ID, enabledEnv);
		const b = deriveXaiConvId(VALID_SESSION_ID, enabledEnv);
		expect(a).toBe(b);
	});

	it("is case-insensitive on the session id", () => {
		const lower = deriveXaiConvId(VALID_SESSION_ID, enabledEnv);
		const upper = deriveXaiConvId(VALID_SESSION_ID.toUpperCase(), enabledEnv);
		expect(lower).toBe(upper);
	});

	it("produces different ids for different session ids", () => {
		const a = deriveXaiConvId(VALID_SESSION_ID, enabledEnv);
		const b = deriveXaiConvId(OTHER_SESSION_ID, enabledEnv);
		expect(a).not.toBe(b);
	});

	it("never includes the raw session UUID (or its dash-stripped form) anywhere in the derived id", () => {
		const id = deriveXaiConvId(VALID_SESSION_ID, enabledEnv) ?? "";
		expect(id).not.toContain(VALID_SESSION_ID);
		expect(id.toLowerCase()).not.toContain(VALID_SESSION_ID.toLowerCase());
		expect(id).not.toContain(VALID_SESSION_ID.replace(/-/g, ""));
		// Guard every dash-delimited fragment individually too.
		for (const fragment of VALID_SESSION_ID.split("-")) {
			expect(id.toLowerCase()).not.toContain(fragment.toLowerCase());
		}
	});

	it("does not just re-encode the session id (e.g. base64) — output must be a hash digest", () => {
		const id = deriveXaiConvId(VALID_SESSION_ID, enabledEnv) ?? "";
		const b64 = Buffer.from(VALID_SESSION_ID).toString("base64");
		expect(id).not.toContain(b64);
	});
});

describe("applyXaiConvIdHeader", () => {
	it("attaches the header when provider is xai, endpoint is official, and a conv id is present", () => {
		const headers = new Headers();
		applyXaiConvIdHeader(headers, "xai", account(), "ccflare-xai-abc123");
		expect(headers.get(XAI_CONV_ID_HEADER)).toBe("ccflare-xai-abc123");
	});

	it("does not attach for a non-xai provider", () => {
		const headers = new Headers();
		applyXaiConvIdHeader(
			headers,
			"anthropic",
			account({ provider: "anthropic" }),
			"ccflare-xai-abc123",
		);
		expect(headers.has(XAI_CONV_ID_HEADER)).toBe(false);
	});

	it("does not attach when the conv id is null (not derivable)", () => {
		const headers = new Headers();
		applyXaiConvIdHeader(headers, "xai", account(), null);
		expect(headers.has(XAI_CONV_ID_HEADER)).toBe(false);
	});

	it("does not attach for a custom/proxy xai endpoint", () => {
		const headers = new Headers();
		applyXaiConvIdHeader(
			headers,
			"xai",
			account({ custom_endpoint: "https://my-proxy.example.com/v1" }),
			"ccflare-xai-abc123",
		);
		expect(headers.has(XAI_CONV_ID_HEADER)).toBe(false);
	});

	it("overwrites any pre-existing header value with the derived one (never trusts client input)", () => {
		const headers = new Headers({ [XAI_CONV_ID_HEADER]: "client-supplied" });
		applyXaiConvIdHeader(headers, "xai", account(), "ccflare-xai-real");
		expect(headers.get(XAI_CONV_ID_HEADER)).toBe("ccflare-xai-real");
	});

	// Regression coverage: a client-supplied x-grok-conv-id must never reach
	// any upstream, including on every early-return (no-op) path below — not
	// just the happy-path overwrite tested above.
	it("strips a pre-existing client-supplied header for a non-xai provider", () => {
		const headers = new Headers({ [XAI_CONV_ID_HEADER]: "client-supplied" });
		applyXaiConvIdHeader(
			headers,
			"anthropic",
			account({ provider: "anthropic" }),
			"ccflare-xai-abc123",
		);
		expect(headers.has(XAI_CONV_ID_HEADER)).toBe(false);
	});

	it("strips a pre-existing client-supplied header when the conv id is null", () => {
		const headers = new Headers({ [XAI_CONV_ID_HEADER]: "client-supplied" });
		applyXaiConvIdHeader(headers, "xai", account(), null);
		expect(headers.has(XAI_CONV_ID_HEADER)).toBe(false);
	});

	it("strips a pre-existing client-supplied header for a custom/proxy xai endpoint", () => {
		const headers = new Headers({ [XAI_CONV_ID_HEADER]: "client-supplied" });
		applyXaiConvIdHeader(
			headers,
			"xai",
			account({ custom_endpoint: "https://my-proxy.example.com/v1" }),
			"ccflare-xai-abc123",
		);
		expect(headers.has(XAI_CONV_ID_HEADER)).toBe(false);
	});
});
