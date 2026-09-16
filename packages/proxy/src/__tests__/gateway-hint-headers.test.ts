/**
 * Tests for the Claude Code "gateway hint" request-header extraction helper.
 *
 * Claude Code CLI >= 2.1.273 can opt in (via
 * `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` client-side) to sending five headers:
 * x-claude-code-request-class, x-claude-code-agent-type,
 * x-claude-code-prev-tool-durations, x-claude-code-compaction, and
 * x-claude-code-context-compacted.
 *
 * Backward compatibility is the load-bearing property here: the overwhelming
 * majority of requests will never carry these headers (older CLI versions,
 * or the opt-in env var left off), and that absence must never surface as an
 * error, a warning, or a behavior change — every field degrades to `null`.
 */
import { describe, expect, it } from "bun:test";
import {
	extractGatewayHintHeaders,
	extractGatewayHintHeadersFromParts,
	extractGatewayHintHeadersFromRequest,
} from "../gateway-hint-headers";

describe("extractGatewayHintHeadersFromRequest", () => {
	it("extracts all five headers when present", () => {
		const headers = new Headers({
			"x-claude-code-request-class": "primary",
			"x-claude-code-agent-type": "general-purpose",
			"x-claude-code-prev-tool-durations": "[120,340,15]",
			"x-claude-code-compaction": "auto",
			"x-claude-code-context-compacted": "true",
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result).toEqual({
			requestClass: "primary",
			agentType: "general-purpose",
			prevToolDurations: "[120,340,15]",
			compaction: "auto",
			contextCompacted: "true",
		});
	});

	it("returns an all-null object when no gateway hint headers are present", () => {
		const headers = new Headers({
			"content-type": "application/json",
			authorization: "Bearer sk-not-a-gateway-hint",
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result).toEqual({
			requestClass: null,
			agentType: null,
			prevToolDurations: null,
			compaction: null,
			contextCompacted: null,
		});
	});

	it("extracts a single present header while the rest stay null", () => {
		const headers = new Headers({
			"x-claude-code-agent-type": "subagent",
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result.agentType).toBe("subagent");
		expect(result.requestClass).toBeNull();
		expect(result.prevToolDurations).toBeNull();
		expect(result.compaction).toBeNull();
		expect(result.contextCompacted).toBeNull();
	});

	it("treats an empty-string header value as absent", () => {
		const headers = new Headers({
			"x-claude-code-request-class": "",
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result.requestClass).toBeNull();
	});

	it("treats a whitespace-only header value as absent", () => {
		const headers = new Headers({
			"x-claude-code-compaction": "   ",
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result.compaction).toBeNull();
	});

	it("trims surrounding whitespace from a real value", () => {
		const headers = new Headers({
			"x-claude-code-request-class": "  background  ",
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result.requestClass).toBe("background");
	});

	it("caps an oversized short-field header instead of storing it verbatim", () => {
		const headers = new Headers({
			"x-claude-code-agent-type": "x".repeat(5000),
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result.agentType).not.toBeNull();
		expect((result.agentType as string).length).toBe(256);
	});

	it("caps an oversized prev-tool-durations header at the wider bound", () => {
		const headers = new Headers({
			"x-claude-code-prev-tool-durations": "9".repeat(10000),
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result.prevToolDurations).not.toBeNull();
		expect((result.prevToolDurations as string).length).toBe(2048);
	});

	it("header lookup is case-insensitive (Headers native behavior)", () => {
		const headers = new Headers({
			"X-Claude-Code-Request-Class": "primary",
		});

		const result = extractGatewayHintHeadersFromRequest(headers);

		expect(result.requestClass).toBe("primary");
	});
});

describe("extractGatewayHintHeadersFromParts", () => {
	it("extracts all five headers from a lower-cased Record map", () => {
		const requestHeaders: Record<string, string> = {
			"x-claude-code-request-class": "primary",
			"x-claude-code-agent-type": "general-purpose",
			"x-claude-code-prev-tool-durations": "[10,20]",
			"x-claude-code-compaction": "manual",
			"x-claude-code-context-compacted": "false",
		};

		const result = extractGatewayHintHeadersFromParts(requestHeaders);

		expect(result).toEqual({
			requestClass: "primary",
			agentType: "general-purpose",
			prevToolDurations: "[10,20]",
			compaction: "manual",
			contextCompacted: "false",
		});
	});

	it("matches header names case-insensitively, like real HTTP headers", () => {
		const requestHeaders: Record<string, string> = {
			"X-Claude-Code-Agent-Type": "general-purpose",
		};

		const result = extractGatewayHintHeadersFromParts(requestHeaders);

		expect(result.agentType).toBe("general-purpose");
	});

	it("returns an all-null object for an empty header map", () => {
		const result = extractGatewayHintHeadersFromParts({});

		expect(result).toEqual({
			requestClass: null,
			agentType: null,
			prevToolDurations: null,
			compaction: null,
			contextCompacted: null,
		});
	});

	it("returns an all-null object for null/undefined input without throwing", () => {
		expect(extractGatewayHintHeadersFromParts(null)).toEqual({
			requestClass: null,
			agentType: null,
			prevToolDurations: null,
			compaction: null,
			contextCompacted: null,
		});
		expect(extractGatewayHintHeadersFromParts(undefined)).toEqual({
			requestClass: null,
			agentType: null,
			prevToolDurations: null,
			compaction: null,
			contextCompacted: null,
		});
	});

	it("agrees with the Headers-based extractor for the same values (both call sites stay in sync)", () => {
		const values = {
			"x-claude-code-request-class": "primary",
			"x-claude-code-agent-type": "general-purpose",
			"x-claude-code-prev-tool-durations": "[1,2,3]",
			"x-claude-code-compaction": "auto",
			"x-claude-code-context-compacted": "true",
		};

		const fromRequest = extractGatewayHintHeadersFromRequest(
			new Headers(values),
		);
		const fromParts = extractGatewayHintHeadersFromParts(values);

		expect(fromParts).toEqual(fromRequest);
	});
});

describe("extractGatewayHintHeaders (core accessor)", () => {
	it("never throws for a getter that returns undefined for everything", () => {
		expect(() => extractGatewayHintHeaders(() => undefined)).not.toThrow();
		expect(extractGatewayHintHeaders(() => undefined)).toEqual({
			requestClass: null,
			agentType: null,
			prevToolDurations: null,
			compaction: null,
			contextCompacted: null,
		});
	});
});
