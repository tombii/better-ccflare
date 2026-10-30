import { describe, expect, test } from "bun:test";
import { detectWebSearchRequest } from "../detect";
import type { DetectOptions } from "../types";

const OPTIONS: DetectOptions = { enabled: true, pathname: "/v1/messages" };

/** The real Claude Code helper request shape. */
function helperBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		model: "claude-sonnet-5-5",
		max_tokens: 4096,
		stream: true,
		messages: [
			{
				role: "user",
				content: "Perform a web search for the query: latest bun release",
			},
		],
		tools: [
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 8,
			},
		],
		...overrides,
	};
}

describe("detectWebSearchRequest", () => {
	test("detects the real Claude Code helper request", () => {
		const detected = detectWebSearchRequest(helperBody(), OPTIONS);
		expect(detected).not.toBeNull();
		expect(detected?.query).toBe("latest bun release");
		expect(detected?.maxUses).toBe(8);
		expect(detected?.toolType).toBe("web_search_20250305");
		expect(detected?.stream).toBe(true);
		expect(detected?.model).toBe("claude-sonnet-5-5");
		expect(detected?.allowedDomains).toBeUndefined();
		expect(detected?.blockedDomains).toBeUndefined();
	});

	test("matches the web_search_ prefix for current and future versions", () => {
		for (const version of ["web_search_20260209", "web_search_20261231"]) {
			const detected = detectWebSearchRequest(
				helperBody({ tools: [{ type: version, name: "web_search" }] }),
				OPTIONS,
			);
			expect(detected?.toolType).toBe(version);
		}
	});

	test("ignores unknown fields on the tool entry and the body", () => {
		const detected = detectWebSearchRequest(
			helperBody({
				context_management: { edits: [] },
				metadata: { user_id: "session-1" },
				tools: [
					{
						type: "web_search_20260209",
						name: "web_search",
						max_uses: 3,
						user_location: { type: "approximate", city: "Berlin" },
						allowed_domains: ["example.com"],
					},
				],
			}),
			OPTIONS,
		);
		expect(detected).not.toBeNull();
		expect(detected?.maxUses).toBe(3);
		expect(detected?.allowedDomains).toEqual(["example.com"]);
	});

	test("defaults maxUses to 8 when the tool omits it", () => {
		const detected = detectWebSearchRequest(
			helperBody({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			OPTIONS,
		);
		expect(detected?.maxUses).toBe(8);
	});

	test("honours the bypass header case-insensitively and trimmed", () => {
		const headers = new Headers({ "x-better-ccflare-web-tools": "  OFF " });
		expect(
			detectWebSearchRequest(helperBody(), { ...OPTIONS, headers }),
		).toBeNull();
	});

	test("an unrelated bypass header value does not disable detection", () => {
		const headers = new Headers({ "x-better-ccflare-web-tools": "on" });
		expect(
			detectWebSearchRequest(helperBody(), { ...OPTIONS, headers }),
		).not.toBeNull();
	});

	test("bypass header is ignored when disabled by config", () => {
		const headers = new Headers({ "x-better-ccflare-web-tools": "off" });
		expect(
			detectWebSearchRequest(helperBody(), {
				...OPTIONS,
				headers,
				bypassHeaderEnabled: false,
			}),
		).not.toBeNull();
	});

	test("returns null when the feature is disabled", () => {
		expect(
			detectWebSearchRequest(helperBody(), { ...OPTIONS, enabled: false }),
		).toBeNull();
	});

	test("returns null for other paths", () => {
		expect(
			detectWebSearchRequest(helperBody(), {
				...OPTIONS,
				pathname: "/v1/complete",
			}),
		).toBeNull();
	});

	test("returns null for malformed bodies", () => {
		expect(detectWebSearchRequest(null, OPTIONS)).toBeNull();
		expect(detectWebSearchRequest("nope", OPTIONS)).toBeNull();
		expect(detectWebSearchRequest([], OPTIONS)).toBeNull();
		expect(
			detectWebSearchRequest({ tools: helperBody().tools }, OPTIONS),
		).toBeNull();
		expect(
			detectWebSearchRequest(helperBody({ messages: "hi" }), OPTIONS),
		).toBeNull();
	});

	test("returns null unless exactly one tool is present", () => {
		expect(
			detectWebSearchRequest(helperBody({ tools: [] }), OPTIONS),
		).toBeNull();
		expect(
			detectWebSearchRequest(
				helperBody({
					tools: [
						{ type: "web_search_20250305", name: "web_search" },
						{ type: "web_search_20250305", name: "web_search" },
					],
				}),
				OPTIONS,
			),
		).toBeNull();
		expect(
			detectWebSearchRequest(
				helperBody({
					tools: [{ type: "computer_20250124", name: "computer" }],
				}),
				OPTIONS,
			),
		).toBeNull();
	});

	test("tool_choice forcing another tool is rejected", () => {
		expect(
			detectWebSearchRequest(
				helperBody({ tool_choice: { type: "tool", name: "bash" } }),
				OPTIONS,
			),
		).toBeNull();
	});

	test("tool_choice forcing web_search or naming no tool is accepted", () => {
		for (const toolChoice of [
			{ type: "tool", name: "web_search" },
			{ type: "auto" },
			{ type: "any" },
			{ type: "none" },
		]) {
			expect(
				detectWebSearchRequest(
					helperBody({ tool_choice: toolChoice }),
					OPTIONS,
				),
			).not.toBeNull();
		}
	});

	test("allowed_domains together with blocked_domains is rejected", () => {
		expect(
			detectWebSearchRequest(
				helperBody({
					tools: [
						{
							type: "web_search_20250305",
							name: "web_search",
							allowed_domains: ["example.com"],
							blocked_domains: ["evil.example"],
						},
					],
				}),
				OPTIONS,
			),
		).toBeNull();
	});

	test("a single domain list is carried through", () => {
		const allowed = detectWebSearchRequest(
			helperBody({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						allowed_domains: ["example.com"],
						blocked_domains: [],
					},
				],
			}),
			OPTIONS,
		);
		expect(allowed?.allowedDomains).toEqual(["example.com"]);
		expect(allowed?.blockedDomains).toBeUndefined();

		const blocked = detectWebSearchRequest(
			helperBody({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						blocked_domains: ["evil.example"],
					},
				],
			}),
			OPTIONS,
		);
		expect(blocked?.blockedDomains).toEqual(["evil.example"]);
		expect(blocked?.allowedDomains).toBeUndefined();
	});

	test("extracts the query from a text-block array and strips the prefix", () => {
		const detected = detectWebSearchRequest(
			helperBody({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Perform   a web search for the query :" },
							{ type: "text", text: "bun 1.4 release notes" },
						],
					},
				],
			}),
			OPTIONS,
		);
		expect(detected?.query).toBe("bun 1.4 release notes");
	});

	test("uses the last user message", () => {
		const detected = detectWebSearchRequest(
			helperBody({
				messages: [
					{
						role: "user",
						content: "Perform a web search for the query: first",
					},
					{ role: "assistant", content: "working on it" },
					{
						role: "user",
						content: "Perform a web search for the query: second",
					},
				],
			}),
			OPTIONS,
		);
		expect(detected?.query).toBe("second");
	});

	test("an empty query after stripping returns null", () => {
		expect(
			detectWebSearchRequest(
				helperBody({
					messages: [
						{
							role: "user",
							content: "Perform a web search for the query:   ",
						},
					],
				}),
				OPTIONS,
			),
		).toBeNull();
	});

	test("a missing user message returns null", () => {
		expect(
			detectWebSearchRequest(
				helperBody({
					messages: [{ role: "assistant", content: "hello" }],
				}),
				OPTIONS,
			),
		).toBeNull();
	});

	test("non-text blocks in the user turn are ignored", () => {
		const detected = detectWebSearchRequest(
			helperBody({
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", source: { type: "base64", data: "..." } },
							{ type: "text", text: "Perform a web search for the query: x" },
						],
					},
				],
			}),
			OPTIONS,
		);
		expect(detected?.query).toBe("x");
	});

	test("non-streaming requests are reported as such", () => {
		const detected = detectWebSearchRequest(
			helperBody({ stream: undefined, model: 42 }),
			OPTIONS,
		);
		expect(detected?.stream).toBe(false);
		expect(detected?.model).toBe("");
	});
});
