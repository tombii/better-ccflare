import { describe, expect, it } from "bun:test";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import {
	applyMistralAffinityHeader,
	deriveMistralAffinityId,
	isMistralEndpoint,
	MISTRAL_AFFINITY_HEADER,
	stripMistralReasoning,
} from "./mistral";

const VALID_SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER_SESSION_ID = "11111111-2222-4333-8444-555555555555";

const AFFINITY_ID_RE = /^ccflare-mistral-[0-9a-f]{32}$/;

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "mistral-1",
		name: "mistral-test",
		provider: "openai-compatible",
		api_key: null,
		refresh_token: "test-api-key",
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

function endpointAccount(endpoint: string): Account {
	return account({ custom_endpoint: JSON.stringify({ endpoint }) });
}

describe("constants", () => {
	it("uses x-affinity as the pod-affinity header name", () => {
		expect(MISTRAL_AFFINITY_HEADER).toBe("x-affinity");
	});
});

describe("isMistralEndpoint", () => {
	it("is true for the global Mistral API host", () => {
		expect(
			isMistralEndpoint(endpointAccount("https://api.mistral.ai/v1")),
		).toBe(true);
	});

	it("is true for the EU Mistral API host", () => {
		expect(
			isMistralEndpoint(endpointAccount("https://api.eu.mistral.ai/v1")),
		).toBe(true);
	});

	it("is true for the US Mistral API host", () => {
		expect(
			isMistralEndpoint(endpointAccount("https://api.us.mistral.ai/v1")),
		).toBe(true);
	});

	it("is true for an uppercase host", () => {
		expect(
			isMistralEndpoint(endpointAccount("https://API.MISTRAL.AI/v1")),
		).toBe(true);
	});

	it("is false for a look-alike host (no suffix matching)", () => {
		expect(
			isMistralEndpoint(endpointAccount("https://evil-api.mistral.ai/v1")),
		).toBe(false);
		expect(
			isMistralEndpoint(endpointAccount("https://api.mistral.ai.evil.com/v1")),
		).toBe(false);
	});

	it("is false for a self-hosted / custom endpoint", () => {
		expect(
			isMistralEndpoint(endpointAccount("https://my-proxy.example.com/v1")),
		).toBe(false);
	});

	it("is false for a missing or unparseable endpoint", () => {
		expect(isMistralEndpoint(undefined)).toBe(false);
		expect(isMistralEndpoint(null)).toBe(false);
		expect(isMistralEndpoint(endpointAccount("not a url"))).toBe(false);
	});
});

describe("deriveMistralAffinityId", () => {
	it("derives a stable, prefixed id for a session UUID", () => {
		const id = deriveMistralAffinityId(VALID_SESSION_ID);
		expect(id).toMatch(AFFINITY_ID_RE);
		expect(deriveMistralAffinityId(VALID_SESSION_ID)).toBe(id);
	});

	it("is case-insensitive on the session id", () => {
		expect(deriveMistralAffinityId(VALID_SESSION_ID.toUpperCase())).toBe(
			deriveMistralAffinityId(VALID_SESSION_ID),
		);
	});

	it("produces different ids for different sessions", () => {
		expect(deriveMistralAffinityId(VALID_SESSION_ID)).not.toBe(
			deriveMistralAffinityId(OTHER_SESSION_ID),
		);
	});

	it("returns null for null, empty, whitespace, non-UUID, and non-string input", () => {
		expect(deriveMistralAffinityId(null)).toBeNull();
		expect(deriveMistralAffinityId(undefined)).toBeNull();
		expect(deriveMistralAffinityId("")).toBeNull();
		expect(deriveMistralAffinityId("   ")).toBeNull();
		expect(deriveMistralAffinityId("not-a-uuid")).toBeNull();
		expect(
			deriveMistralAffinityId(
				"3fa85f6457174562b3fc2c963f66afa6" as unknown as string,
			),
		).toBeNull();
		expect(deriveMistralAffinityId(42 as unknown as string)).toBeNull();
	});

	it("never includes the raw session id in the output", () => {
		const id = deriveMistralAffinityId(VALID_SESSION_ID) ?? "";
		expect(id).not.toContain(VALID_SESSION_ID);
		expect(id.toLowerCase()).not.toContain(VALID_SESSION_ID.toLowerCase());
		expect(id).not.toContain(VALID_SESSION_ID.replace(/-/g, ""));
	});
});

describe("applyMistralAffinityHeader", () => {
	const affinityId = "ccflare-mistral-0123456789abcdef0123456789abcdef";

	it("sets the header on a global Mistral account", () => {
		const headers = new Headers();
		applyMistralAffinityHeader(
			headers,
			endpointAccount("https://api.mistral.ai/v1"),
			affinityId,
		);
		expect(headers.get(MISTRAL_AFFINITY_HEADER)).toBe(affinityId);
	});

	it("sets the header on an EU Mistral account", () => {
		const headers = new Headers();
		applyMistralAffinityHeader(
			headers,
			endpointAccount("https://api.eu.mistral.ai/v1"),
			affinityId,
		);
		expect(headers.get(MISTRAL_AFFINITY_HEADER)).toBe(affinityId);
	});

	it("leaves headers untouched for a non-Mistral endpoint", () => {
		const headers = new Headers({
			[MISTRAL_AFFINITY_HEADER]: "client-supplied",
		});
		applyMistralAffinityHeader(
			headers,
			endpointAccount("https://api.openai.com/v1"),
			affinityId,
		);
		expect(headers.get(MISTRAL_AFFINITY_HEADER)).toBe("client-supplied");
	});

	it("deletes a client-supplied header on a Mistral endpoint when the id is null", () => {
		const headers = new Headers({
			[MISTRAL_AFFINITY_HEADER]: "client-supplied",
		});
		applyMistralAffinityHeader(
			headers,
			endpointAccount("https://api.mistral.ai/v1"),
			null,
		);
		expect(headers.has(MISTRAL_AFFINITY_HEADER)).toBe(false);
	});

	it("overwrites a client-supplied value when an id is present", () => {
		const headers = new Headers({
			[MISTRAL_AFFINITY_HEADER]: "client-supplied",
		});
		applyMistralAffinityHeader(
			headers,
			endpointAccount("https://api.mistral.ai/v1"),
			affinityId,
		);
		expect(headers.get(MISTRAL_AFFINITY_HEADER)).toBe(affinityId);
	});
});

describe("stripMistralReasoning", () => {
	it("moves assistant reasoning_content into a leading typed thinking chunk", () => {
		const body: OpenAIRequest = {
			model: "mistral-large-latest",
			messages: [
				{ role: "user", content: "Hi" },
				{
					role: "assistant",
					content: "The answer.",
					reasoning_content: "Let me think.",
				},
			],
		};

		stripMistralReasoning(body);

		expect(body.messages[1].reasoning_content).toBeUndefined();
		expect(body.messages[1].content).toEqual([
			{
				type: "thinking",
				thinking: [{ type: "text", text: "Let me think." }],
				closed: true,
			},
			{ type: "text", text: "The answer." },
		]);
	});
});
