import { describe, expect, it } from "bun:test";
import {
	ROUTE_INTENT_ALLOW_PROVIDERS_HEADER,
	resolveRouteIntent,
} from "../route-intent";

describe("resolveRouteIntent", () => {
	it("excludes codex from unprefixed /v1/messages by default", () => {
		const intent = resolveRouteIntent("/v1/messages");
		expect(intent.excludeProviders).toContain("codex");
		expect(intent.includeProviders).toEqual([]);
	});

	it("excludes codex from /v1/messages/count_tokens by default", () => {
		const intent = resolveRouteIntent("/v1/messages/count_tokens");
		expect(intent.excludeProviders).toContain("codex");
	});

	it("allows codex on /v1/messages when opt-in header is present", () => {
		const headers = new Headers({
			[ROUTE_INTENT_ALLOW_PROVIDERS_HEADER]: "codex",
		});
		const intent = resolveRouteIntent("/v1/messages", headers);
		expect(intent.excludeProviders).not.toContain("codex");
	});

	it("merges explicit exclude-providers with default codex exclusion", () => {
		const headers = new Headers({
			"x-better-ccflare-exclude-providers": "ollama",
		});
		const intent = resolveRouteIntent("/v1/messages", headers);
		expect(intent.excludeProviders).toContain("codex");
		expect(intent.excludeProviders).toContain("ollama");
	});

	it("does not apply default codex exclusion when include-providers is set", () => {
		const headers = new Headers({
			"x-better-ccflare-include-providers": "codex",
		});
		const intent = resolveRouteIntent("/v1/codex/responses", headers);
		expect(intent.includeProviders).toEqual(["codex"]);
		expect(intent.excludeProviders).not.toContain("codex");
	});

	it("does not exclude codex from native codex paths without headers", () => {
		const intent = resolveRouteIntent("/v1/codex/responses");
		expect(intent.excludeProviders).not.toContain("codex");
	});
});
