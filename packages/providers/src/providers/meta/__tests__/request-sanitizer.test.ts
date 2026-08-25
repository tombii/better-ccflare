import {
	effortForThinkingBudget,
	META_MAX_OUTPUT_TOKENS,
	sanitizeMetaRequestBody,
} from "../request-sanitizer";

/** Minimal valid body; individual tests layer their case on top. */
function baseBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		model: "muse-spark-1.2",
		max_tokens: 4096,
		messages: [{ role: "user", content: "hi" }],
		...overrides,
	};
}

describe("sanitizeMetaRequestBody", () => {
	describe("top-level allowlist", () => {
		it("passes a already-valid body through unchanged", () => {
			const body = baseBody({
				system: "be terse",
				temperature: 0.5,
				top_p: 0.9,
				stream: true,
				metadata: { user_id: "abc" },
				service_tier: "auto",
			});
			const result = sanitizeMetaRequestBody(body);
			expect(result.body).toEqual(body);
			expect(result.changes).toEqual([]);
		});

		it("drops the documented unsupported top-level fields", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					stop_sequences: ["\n\n"],
					top_k: 40,
					container: "x",
					inference_geo: "eu",
				}),
			);
			expect(result.body).not.toHaveProperty("stop_sequences");
			expect(result.body).not.toHaveProperty("top_k");
			expect(result.body).not.toHaveProperty("container");
			expect(result.body).not.toHaveProperty("inference_geo");
			expect(result.changes).toContain(
				"dropped_unsupported_field:stop_sequences",
			);
			expect(result.changes).toContain("dropped_unsupported_field:top_k");
		});

		it("drops unknown top-level fields, which Meta rejects outright", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({ some_future_field: 1, mcp_servers: [] }),
			);
			expect(result.body).not.toHaveProperty("some_future_field");
			expect(result.body).not.toHaveProperty("mcp_servers");
			expect(result.changes).toContain(
				"dropped_unsupported_field:some_future_field",
			);
		});

		it("never mutates the caller's object", () => {
			const body = baseBody({ top_k: 40 });
			sanitizeMetaRequestBody(body);
			expect(body).toHaveProperty("top_k", 40);
		});

		it("returns an empty body for a non-object input", () => {
			expect(sanitizeMetaRequestBody(null).body).toEqual({});
			expect(sanitizeMetaRequestBody("nope").body).toEqual({});
			expect(sanitizeMetaRequestBody([1, 2]).body).toEqual({});
		});
	});

	describe("max_tokens", () => {
		it("clamps above the Meta output ceiling", () => {
			const result = sanitizeMetaRequestBody(baseBody({ max_tokens: 200_000 }));
			expect(result.body.max_tokens).toBe(META_MAX_OUTPUT_TOKENS);
			expect(result.changes).toContain(
				`clamped_max_tokens:200000->${META_MAX_OUTPUT_TOKENS}`,
			);
		});

		it("leaves an in-range value alone", () => {
			const result = sanitizeMetaRequestBody(baseBody({ max_tokens: 8192 }));
			expect(result.body.max_tokens).toBe(8192);
			expect(result.changes).toEqual([]);
		});
	});

	describe("temperature", () => {
		it("clamps to Anthropic's enforced 0-1 range", () => {
			expect(
				sanitizeMetaRequestBody(baseBody({ temperature: 1.8 })).body
					.temperature,
			).toBe(1);
			expect(
				sanitizeMetaRequestBody(baseBody({ temperature: -0.5 })).body
					.temperature,
			).toBe(0);
		});
	});

	describe("system", () => {
		it("keeps a plain string", () => {
			const result = sanitizeMetaRequestBody(baseBody({ system: "be terse" }));
			expect(result.body.system).toBe("be terse");
		});

		it("keeps text blocks and drops every other block type", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					system: [
						{ type: "text", text: "a" },
						{ type: "image", source: {} },
						{ type: "text", text: "b" },
					],
				}),
			);
			expect(result.body.system).toEqual([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]);
			expect(result.changes).toContain("dropped_system_blocks:1");
		});

		it("preserves cache_control on a text block", () => {
			const block = {
				type: "text",
				text: "a",
				cache_control: { type: "ephemeral" },
			};
			const result = sanitizeMetaRequestBody(baseBody({ system: [block] }));
			expect(result.body.system).toEqual([block]);
		});

		it("removes system entirely when no text block survives", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({ system: [{ type: "image", source: {} }] }),
			);
			expect(result.body).not.toHaveProperty("system");
		});
	});

	describe("service_tier", () => {
		it("keeps the accepted values", () => {
			expect(
				sanitizeMetaRequestBody(baseBody({ service_tier: "auto" })).body
					.service_tier,
			).toBe("auto");
			expect(
				sanitizeMetaRequestBody(baseBody({ service_tier: "standard_only" }))
					.body.service_tier,
			).toBe("standard_only");
		});

		it("drops any other value", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({ service_tier: "batch" }),
			);
			expect(result.body).not.toHaveProperty("service_tier");
			expect(result.changes).toContain("dropped_service_tier:batch");
		});
	});

	describe("thinking", () => {
		it("drops type:disabled, which Meta rejects", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({ thinking: { type: "disabled" } }),
			);
			expect(result.body).not.toHaveProperty("thinking");
			expect(result.changes).toContain("dropped_thinking:disabled_unsupported");
		});

		it("keeps type:adaptive untouched", () => {
			const thinking = { type: "adaptive" };
			const result = sanitizeMetaRequestBody(baseBody({ thinking }));
			expect(result.body.thinking).toEqual(thinking);
		});

		it("keeps a valid enabled budget and derives a reasoning effort", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					max_tokens: 32_000,
					thinking: { type: "enabled", budget_tokens: 10_000 },
				}),
			);
			expect(result.body.thinking).toEqual({
				type: "enabled",
				budget_tokens: 10_000,
			});
			expect(result.body.output_config).toEqual({ effort: "medium" });
		});

		it("raises a budget below Meta's 1024 minimum", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					max_tokens: 8192,
					thinking: { type: "enabled", budget_tokens: 500 },
				}),
			);
			expect(
				(result.body.thinking as Record<string, unknown>).budget_tokens,
			).toBe(1024);
			expect(result.changes).toContain("clamped_thinking_budget:500->1024");
		});

		it("clamps a budget that is not strictly below max_tokens", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					max_tokens: 4096,
					thinking: { type: "enabled", budget_tokens: 4096 },
				}),
			);
			expect(
				(result.body.thinking as Record<string, unknown>).budget_tokens,
			).toBe(4095);
		});

		it("drops thinking when max_tokens leaves no room for the minimum budget", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					max_tokens: 512,
					thinking: { type: "enabled", budget_tokens: 4096 },
				}),
			);
			expect(result.body).not.toHaveProperty("thinking");
			expect(result.changes).toContain("dropped_thinking:max_tokens_too_small");
		});

		it("does not override an explicit output_config.effort", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					max_tokens: 32_000,
					thinking: { type: "enabled", budget_tokens: 10_000 },
					output_config: { effort: "xhigh" },
				}),
			);
			expect(result.body.output_config).toEqual({ effort: "xhigh" });
		});

		it("drops an unrecognised thinking type", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({ thinking: { type: "turbo" } }),
			);
			expect(result.body).not.toHaveProperty("thinking");
		});
	});

	describe("effortForThinkingBudget", () => {
		it("maps budgets onto Meta's four effort tiers", () => {
			expect(effortForThinkingBudget(1_024)).toBe("low");
			expect(effortForThinkingBudget(4_096)).toBe("medium");
			expect(effortForThinkingBudget(16_384)).toBe("high");
			expect(effortForThinkingBudget(31_999)).toBe("high");
			expect(effortForThinkingBudget(32_768)).toBe("xhigh");
		});
	});

	describe("output_config", () => {
		it("drops an invalid effort but keeps the rest of the config", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					output_config: {
						effort: "extreme",
						format: { type: "json_schema", schema: {} },
					},
				}),
			);
			expect(result.body.output_config).toEqual({
				format: { type: "json_schema", schema: {} },
			});
			expect(result.changes).toContain("dropped_effort:extreme");
		});

		it("removes output_config entirely when nothing valid remains", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({ output_config: { effort: "extreme" } }),
			);
			expect(result.body).not.toHaveProperty("output_config");
		});
	});

	describe("tool_choice", () => {
		const weather = {
			name: "get_weather",
			description: "w",
			input_schema: {},
		};
		const wire = {
			name: "send_wire_transfer",
			description: "$",
			input_schema: {},
		};

		// Meta rejects a named choice, but rewriting it to `any` on its own would
		// leave every declared tool callable — the model could invoke a tool the
		// caller never authorized, including one with side effects.
		it("narrows the tool list to the named tool, not just the choice", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					tools: [weather, wire],
					tool_choice: { type: "tool", name: "get_weather" },
				}),
			);
			expect(result.body.tool_choice).toEqual({ type: "any" });
			expect(result.body.tools).toEqual([weather]);
			expect(result.changes).toContain(
				"narrowed_tools_to_named_choice:get_weather",
			);
		});

		it("never leaves an unauthorized tool callable", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					tools: [weather, wire],
					tool_choice: { type: "tool", name: "get_weather" },
				}),
			);
			const names = (result.body.tools as Array<{ name: string }>).map(
				(t) => t.name,
			);
			expect(names).not.toContain("send_wire_transfer");
		});

		// A named tool that was never declared is a malformed request: emptying
		// the list makes the upstream reject it instead of the proxy quietly
		// authorizing every other tool.
		it("fails closed when the named tool is not declared", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					tools: [wire],
					tool_choice: { type: "tool", name: "missing_tool" },
				}),
			);
			expect(result.body.tools).toEqual([]);
			expect(result.changes).toContain("named_tool_not_declared:missing_tool");
		});

		it("preserves disable_parallel_tool_use through the rewrite", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					tools: [{ name: "x", description: "x", input_schema: {} }],
					tool_choice: {
						type: "tool",
						name: "x",
						disable_parallel_tool_use: true,
					},
				}),
			);
			expect(result.body.tool_choice).toEqual({
				type: "any",
				disable_parallel_tool_use: true,
			});
		});

		it("keeps auto, any and none untouched", () => {
			for (const type of ["auto", "any", "none"]) {
				const result = sanitizeMetaRequestBody(
					baseBody({ tool_choice: { type } }),
				);
				expect(result.body.tool_choice).toEqual({ type });
			}
		});
	});

	describe("tools", () => {
		// Meta honours none of allowed_domains / blocked_domains / max_uses.
		// Stripping just those fields would leave search enabled but UNBOUNDED,
		// silently widening the caller's security, compliance and cost boundary.
		it("drops a constrained web_search tool entirely rather than unbounding it", () => {
			const result = sanitizeMetaRequestBody(
				baseBody({
					tools: [
						{
							type: "web_search_20250305",
							name: "web_search",
							max_uses: 5,
							allowed_domains: ["example.com"],
							blocked_domains: ["spam.com"],
							user_location: { type: "approximate" },
						},
					],
				}),
			);
			expect(result.body.tools).toEqual([]);
			expect(
				result.changes.some((c) => c.startsWith("dropped_web_search_tool:")),
			).toBe(true);
		});

		it("keeps other tools when a constrained web_search is dropped", () => {
			const calc = { name: "calc", description: "c", input_schema: {} };
			const result = sanitizeMetaRequestBody(
				baseBody({
					tools: [
						calc,
						{
							type: "web_search_20250305",
							name: "web_search",
							allowed_domains: ["example.com"],
						},
					],
				}),
			);
			expect(result.body.tools).toEqual([calc]);
		});

		it("keeps an unconstrained web_search tool, which broadens nothing", () => {
			const search = {
				type: "web_search_20250305",
				name: "web_search",
				user_location: { type: "approximate" },
			};
			const result = sanitizeMetaRequestBody(baseBody({ tools: [search] }));
			expect(result.body.tools).toEqual([search]);
			expect(result.changes).toEqual([]);
		});

		it("leaves developer-defined tools untouched", () => {
			const tool = {
				name: "get_weather",
				description: "Get weather",
				input_schema: { type: "object", properties: {} },
			};
			const result = sanitizeMetaRequestBody(baseBody({ tools: [tool] }));
			expect(result.body.tools).toEqual([tool]);
			expect(result.changes).toEqual([]);
		});
	});

	describe("realistic Claude Code request", () => {
		it("produces a body containing only fields Meta accepts", () => {
			const result = sanitizeMetaRequestBody({
				model: "claude-opus-4-6-20260115",
				max_tokens: 32_000,
				messages: [{ role: "user", content: "refactor this" }],
				system: [
					{
						type: "text",
						text: "You are Claude Code",
						cache_control: { type: "ephemeral" },
					},
				],
				temperature: 1,
				stop_sequences: [],
				top_k: 0,
				metadata: { user_id: "user_abc" },
				stream: true,
				thinking: { type: "enabled", budget_tokens: 31_999 },
				tool_choice: { type: "auto" },
				tools: [{ name: "Bash", description: "run", input_schema: {} }],
			});

			const allowed = new Set([
				"model",
				"messages",
				"max_tokens",
				"system",
				"temperature",
				"top_p",
				"stream",
				"metadata",
				"service_tier",
				"thinking",
				"output_config",
				"tools",
				"tool_choice",
			]);
			for (const key of Object.keys(result.body)) {
				expect(allowed.has(key)).toBe(true);
			}
			expect(result.body.output_config).toEqual({ effort: "high" });
			// The sanitizer does not map model names; the provider does.
			expect(result.body.model).toBe("claude-opus-4-6-20260115");
		});
	});
});
