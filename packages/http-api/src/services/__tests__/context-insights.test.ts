import { describe, expect, test } from "bun:test";
import {
	analyzePayloadJson,
	buildContextInsightsResponse,
	CHARS_PER_TOKEN,
	type ContextGrowthRow,
	type ContextInsightsResponse,
	type ContextRequestRow,
	type ContributorBlock,
	DEFAULT_SESSION_GAP_MINUTES,
	DEFAULT_TOP_CONTRIBUTORS,
	ESTIMATE_NOTE,
	estimateTokens,
	MAX_GROWTH_SESSIONS,
	MAX_POINTS_PER_SESSION,
	MIN_CONTRIBUTOR_BLOCK_CHARS,
	type PayloadAnalysis,
} from "../context-insights";

/**
 * Tests for the pure context-composition service: payload parsing/measuring
 * (analyzePayloadJson) and response aggregation (buildContextInsightsResponse).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a provider request body the way the proxy stores it in request_payloads.json. */
function wrapBody(body: unknown): string {
	return JSON.stringify({
		request: {
			headers: { "content-type": "application/json" },
			body: Buffer.from(JSON.stringify(body), "utf-8").toString("base64"),
		},
		response: { status: 200, headers: {}, body: "" },
		meta: { accountId: "a1", timestamp: 1, success: true, isStream: false },
	});
}

/** A string long enough to clear the contributor block size filter. */
function bigText(
	fill: string,
	length = MIN_CONTRIBUTOR_BLOCK_CHARS + 100,
): string {
	return fill.repeat(Math.ceil(length / fill.length)).slice(0, length);
}

function row(partial: Partial<ContextRequestRow> = {}): ContextRequestRow {
	return {
		id: "r1",
		timestamp: 1_000,
		account: "acct-A",
		model: "claude-sonnet-4-20250514",
		project: "proj-x",
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		...partial,
	};
}

function analysis(partial: Partial<PayloadAnalysis> = {}): PayloadAnalysis {
	return {
		systemChars: 0,
		toolsChars: 0,
		messagesChars: 0,
		totalChars: 0,
		blocks: [],
		...partial,
	};
}

function block(partial: Partial<ContributorBlock> = {}): ContributorBlock {
	return {
		kind: "tool_result",
		label: "ReadFile",
		chars: 1_000,
		hash: "h1",
		...partial,
	};
}

function growthRow(partial: Partial<ContextGrowthRow> = {}): ContextGrowthRow {
	return {
		id: "g1",
		timestamp: 1_000,
		project: "proj-x",
		inputTokens: 10,
		cacheReadInputTokens: 20,
		cacheCreationInputTokens: 30,
		outputTokens: 5,
		...partial,
	};
}

function build(
	overrides: {
		analyses?: Array<{
			row: ContextRequestRow;
			analysis: PayloadAnalysis | null;
		}>;
		coverage?: { requestsInRange: number; requestsWithPayload: number };
		growthRows?: ContextGrowthRow[];
		range?: string;
		truncated?: boolean;
		growthScanTruncated?: boolean;
		topContributors?: number;
		sessionGapMinutes?: number;
	} = {},
): ContextInsightsResponse {
	return buildContextInsightsResponse({
		analyses: overrides.analyses ?? [],
		coverage: overrides.coverage ?? {
			requestsInRange: 0,
			requestsWithPayload: 0,
		},
		growthRows: overrides.growthRows ?? [],
		options: {
			range: overrides.range ?? "24h",
			truncated: overrides.truncated ?? false,
			growthScanTruncated: overrides.growthScanTruncated,
			topContributors: overrides.topContributors,
			sessionGapMinutes: overrides.sessionGapMinutes,
		},
	});
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
	test("rounds chars / CHARS_PER_TOKEN", () => {
		expect(CHARS_PER_TOKEN).toBe(4);
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(4)).toBe(1);
		expect(estimateTokens(10)).toBe(3); // 2.5 rounds up
		expect(estimateTokens(9)).toBe(2); // 2.25 rounds down
	});
});

// ---------------------------------------------------------------------------
// analyzePayloadJson
// ---------------------------------------------------------------------------

describe("analyzePayloadJson", () => {
	test("measures an Anthropic body with a string system prompt", () => {
		const body = {
			model: "claude-sonnet-4-20250514",
			system: "You are a helpful assistant.",
			tools: [{ name: "ReadFile", input_schema: { type: "object" } }],
			messages: [{ role: "user", content: "hello" }],
		};
		const result = analyzePayloadJson(wrapBody(body));
		expect(result).not.toBeNull();
		expect(result?.systemChars).toBe(JSON.stringify(body.system).length);
		expect(result?.toolsChars).toBe(JSON.stringify(body.tools).length);
		expect(result?.messagesChars).toBe(JSON.stringify(body.messages).length);
		expect(result?.totalChars).toBe(
			(result?.systemChars ?? 0) +
				(result?.toolsChars ?? 0) +
				(result?.messagesChars ?? 0),
		);
	});

	test("measures an Anthropic body with an array system prompt", () => {
		const system = [
			{
				type: "text",
				text: "You are Claude.",
				cache_control: { type: "ephemeral" },
			},
		];
		const result = analyzePayloadJson(wrapBody({ system, messages: [] }));
		expect(result?.systemChars).toBe(JSON.stringify(system).length);
		expect(result?.toolsChars).toBe(0);
	});

	test("resolves tool_result labels via the same-request tool_use id map", () => {
		const big = bigText("output ");
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_1",
							name: "Bash",
							input: { cmd: "ls" },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: big },
					],
				},
			],
		};
		const result = analyzePayloadJson(wrapBody(body));
		expect(result).not.toBeNull();
		const toolResults = result?.blocks.filter((b) => b.kind === "tool_result");
		expect(toolResults).toHaveLength(1);
		expect(toolResults?.[0].label).toBe("Bash");
	});

	test("falls back to the 'tool_result' label when the tool_use id is unknown", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_missing",
							content: bigText("x"),
						},
					],
				},
			],
		};
		const result = analyzePayloadJson(wrapBody(body));
		expect(result?.blocks[0]?.label).toBe("tool_result");
	});

	test("extracts text and tool_use blocks with previews/names as labels", () => {
		const longText = bigText("The quick   brown\nfox. ");
		const body = {
			messages: [
				{ role: "user", content: [{ type: "text", text: longText }] },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_2",
							name: "WriteFile",
							input: { content: bigText("y") },
						},
					],
				},
			],
		};
		const result = analyzePayloadJson(wrapBody(body));
		const kinds = result?.blocks.map((b) => b.kind).sort();
		expect(kinds).toEqual(["text", "tool_use"]);
		const text = result?.blocks.find((b) => b.kind === "text");
		// Preview is single-line (whitespace collapsed) and at most 80 chars.
		expect(text?.label.length).toBeLessThanOrEqual(80);
		expect(text?.label).not.toContain("\n");
		expect(text?.label).not.toContain("  ");
		const toolUse = result?.blocks.find((b) => b.kind === "tool_use");
		expect(toolUse?.label).toBe("WriteFile");
	});

	test("counts string message content as a single text block", () => {
		const longText = bigText("string content ");
		const result = analyzePayloadJson(
			wrapBody({ messages: [{ role: "user", content: longText }] }),
		);
		expect(result?.blocks).toHaveLength(1);
		expect(result?.blocks[0].kind).toBe("text");
	});

	test("skips blocks under MIN_CONTRIBUTOR_BLOCK_CHARS", () => {
		const result = analyzePayloadJson(
			wrapBody({
				messages: [{ role: "user", content: [{ type: "text", text: "tiny" }] }],
			}),
		);
		expect(result?.blocks).toEqual([]);
		// ...but the chars are still measured.
		expect(result?.messagesChars).toBeGreaterThan(0);
	});

	test("tolerates OpenAI-format bodies (no system key, function tools)", () => {
		const body = {
			model: "gpt-4o",
			tools: [
				{
					type: "function",
					function: { name: "get_weather", parameters: { type: "object" } },
				},
			],
			messages: [
				{ role: "system", content: "You are helpful." },
				{ role: "user", content: bigText("question ") },
			],
		};
		const result = analyzePayloadJson(wrapBody(body));
		expect(result?.systemChars).toBe(0);
		expect(result?.toolsChars).toBe(JSON.stringify(body.tools).length);
		expect(result?.messagesChars).toBe(JSON.stringify(body.messages).length);
		expect(result?.blocks.some((b) => b.kind === "text")).toBe(true);
	});

	test("returns 0 for missing keys", () => {
		const result = analyzePayloadJson(wrapBody({ model: "m" }));
		expect(result).toEqual({
			systemChars: 0,
			toolsChars: 0,
			messagesChars: 0,
			totalChars: 0,
			blocks: [],
		});
	});

	test("returns null for an unparseable wrapper", () => {
		expect(analyzePayloadJson("not json at all")).toBeNull();
		expect(analyzePayloadJson("enc:abcdef0123")).toBeNull();
	});

	test("returns null when request.body is missing", () => {
		expect(
			analyzePayloadJson(JSON.stringify({ request: { headers: {} } })),
		).toBeNull();
		expect(analyzePayloadJson(JSON.stringify({ meta: {} }))).toBeNull();
	});

	test("returns null for invalid base64 / non-JSON decoded bodies", () => {
		const wrapper = JSON.stringify({
			request: {
				body: Buffer.from("plain text, not json", "utf-8").toString("base64"),
			},
		});
		expect(analyzePayloadJson(wrapper)).toBeNull();
	});

	test("returns null for a body truncated mid-JSON (4MB write cap)", () => {
		const full = JSON.stringify({
			messages: [{ role: "user", content: "hi" }],
		});
		const truncatedBody = full.slice(0, full.length - 5);
		const wrapper = JSON.stringify({
			request: { body: Buffer.from(truncatedBody, "utf-8").toString("base64") },
		});
		expect(analyzePayloadJson(wrapper)).toBeNull();
	});

	test("re-sent identical blocks hash identically; different content does not", () => {
		const big = bigText("repeated ");
		const make = (text: string) =>
			analyzePayloadJson(
				wrapBody({
					messages: [{ role: "user", content: [{ type: "text", text }] }],
				}),
			);
		const first = make(big);
		const second = make(big);
		const different = make(bigText("other "));
		expect(first?.blocks[0].hash).toBe(second?.blocks[0].hash as string);
		expect(first?.blocks[0].hash).not.toBe(different?.blocks[0].hash as string);
	});
});

// ---------------------------------------------------------------------------
// buildContextInsightsResponse — composition + meta
// ---------------------------------------------------------------------------

describe("buildContextInsightsResponse composition", () => {
	test("sums chars, estimates tokens and computes percentages of totalChars", () => {
		const response = build({
			analyses: [
				{
					row: row({ id: "r1", inputTokens: 100, cacheReadInputTokens: 200 }),
					analysis: analysis({
						systemChars: 400,
						toolsChars: 200,
						messagesChars: 400,
						totalChars: 1_000,
					}),
				},
				{
					row: row({ id: "r2", cacheCreationInputTokens: 50 }),
					analysis: analysis({
						systemChars: 600,
						toolsChars: 0,
						messagesChars: 400,
						totalChars: 1_000,
					}),
				},
			],
			coverage: { requestsInRange: 5, requestsWithPayload: 2 },
		});

		const totals = response.composition.totals;
		expect(totals.systemChars).toBe(1_000);
		expect(totals.toolsChars).toBe(200);
		expect(totals.messagesChars).toBe(800);
		expect(totals.totalChars).toBe(2_000);
		expect(totals.estimatedTokens).toEqual({
			system: 250,
			tools: 50,
			messages: 200,
			total: 500,
		});
		expect(totals.percentages.system).toBeCloseTo(50, 10);
		expect(totals.percentages.tools).toBeCloseTo(10, 10);
		expect(totals.percentages.messages).toBeCloseTo(40, 10);

		// Exact token sums come from the request rows, not chars.
		expect(response.composition.tokenTotals).toEqual({
			uncachedInputTokens: 100,
			cacheReadInputTokens: 200,
			cacheCreationInputTokens: 50,
		});
	});

	test("returns zero percentages when totalChars is 0", () => {
		const response = build({
			analyses: [{ row: row(), analysis: analysis() }],
		});
		expect(response.composition.totals.percentages).toEqual({
			system: 0,
			tools: 0,
			messages: 0,
		});
		expect(response.composition.totals.estimatedTokens.total).toBe(0);
	});

	test("excludes unparsed payloads from perRequest and tokenTotals but counts them in meta", () => {
		const response = build({
			analyses: [
				{
					row: row({ id: "r-old", timestamp: 1_000 }),
					analysis: analysis({ systemChars: 4, totalChars: 4 }),
				},
				{ row: row({ id: "r-bad", inputTokens: 999 }), analysis: null },
				{
					row: row({ id: "r-new", timestamp: 2_000 }),
					analysis: analysis({ messagesChars: 8, totalChars: 8 }),
				},
			],
			truncated: true,
			coverage: { requestsInRange: 10, requestsWithPayload: 3 },
			range: "7d",
		});

		// perRequest: parsed only, most recent first.
		expect(response.composition.perRequest.map((r) => r.id)).toEqual([
			"r-new",
			"r-old",
		]);
		expect(response.composition.tokenTotals.uncachedInputTokens).toBe(0);

		expect(response.meta.range).toBe("7d");
		expect(response.meta.scannedPayloads).toBe(3);
		expect(response.meta.parsedPayloads).toBe(2);
		expect(response.meta.unparseablePayloads).toBe(1);
		expect(response.meta.truncated).toBe(true);
		expect(response.meta.payloadCoverage).toEqual({
			requestsInRange: 10,
			requestsWithPayload: 3,
		});
		expect(response.meta.estimateNote).toBe(ESTIMATE_NOTE);
		expect(response.meta.generatedAt).toBeGreaterThan(0);
	});

	test("carries row metadata and estimated tokens onto perRequest entries", () => {
		const response = build({
			analyses: [
				{
					row: row({
						id: "r1",
						timestamp: 42,
						account: null,
						model: null,
						project: null,
						inputTokens: 1,
						cacheReadInputTokens: 2,
						cacheCreationInputTokens: 3,
						outputTokens: 4,
					}),
					analysis: analysis({
						systemChars: 10,
						toolsChars: 20,
						messagesChars: 30,
						totalChars: 60,
					}),
				},
			],
		});
		expect(response.composition.perRequest[0]).toEqual({
			id: "r1",
			timestamp: 42,
			account: null,
			model: null,
			project: null,
			systemChars: 10,
			toolsChars: 20,
			messagesChars: 30,
			totalChars: 60,
			estimatedContextTokens: 15,
			inputTokens: 1,
			cacheReadInputTokens: 2,
			cacheCreationInputTokens: 3,
			outputTokens: 4,
		});
	});
});

// ---------------------------------------------------------------------------
// buildContextInsightsResponse — top contributors
// ---------------------------------------------------------------------------

describe("buildContextInsightsResponse contributors", () => {
	test("groups re-sent blocks by hash across requests", () => {
		const shared = block({ hash: "shared", chars: 2_000, label: "Bash" });
		const response = build({
			analyses: [
				{
					row: row({ id: "r1" }),
					analysis: analysis({
						blocks: [shared, block({ hash: "solo", chars: 900 })],
					}),
				},
				{
					row: row({ id: "r2" }),
					analysis: analysis({ blocks: [{ ...shared, chars: 2_500 }] }),
				},
			],
		});

		expect(response.topContributors).toHaveLength(2);
		const [top, second] = response.topContributors;
		expect(top.label).toBe("Bash");
		expect(top.maxChars).toBe(2_500);
		expect(top.estimatedTokens).toBe(625);
		expect(top.occurrences).toBe(2);
		expect(top.requestCount).toBe(2);
		expect(second.maxChars).toBe(900);
		expect(second.requestCount).toBe(1);
	});

	test("counts repeats within one request as occurrences but one request", () => {
		const repeated = block({ hash: "dup" });
		const response = build({
			analyses: [
				{
					row: row({ id: "r1" }),
					analysis: analysis({ blocks: [repeated, repeated] }),
				},
			],
		});
		expect(response.topContributors[0].occurrences).toBe(2);
		expect(response.topContributors[0].requestCount).toBe(1);
	});

	test("sorts by maxChars descending and applies the topContributors cap", () => {
		const blocks = Array.from({ length: 5 }, (_, index) =>
			block({ hash: `h${index}`, chars: 600 + index * 100 }),
		);
		const response = build({
			analyses: [{ row: row(), analysis: analysis({ blocks }) }],
			topContributors: 3,
		});
		expect(response.topContributors.map((c) => c.maxChars)).toEqual([
			1_000, 900, 800,
		]);
	});

	test("defaults the contributor cap to DEFAULT_TOP_CONTRIBUTORS", () => {
		const blocks = Array.from(
			{ length: DEFAULT_TOP_CONTRIBUTORS + 5 },
			(_, index) => block({ hash: `h${index}`, chars: 600 + index }),
		);
		const response = build({
			analyses: [{ row: row(), analysis: analysis({ blocks }) }],
		});
		expect(response.topContributors).toHaveLength(DEFAULT_TOP_CONTRIBUTORS);
	});
});

// ---------------------------------------------------------------------------
// buildContextInsightsResponse — growth curve
// ---------------------------------------------------------------------------

describe("buildContextInsightsResponse growth curve", () => {
	const MINUTE = 60_000;

	test("groups by project and splits sessions on the time gap", () => {
		const gap = DEFAULT_SESSION_GAP_MINUTES * MINUTE;
		const response = build({
			growthRows: [
				// proj-x: two requests close together, then one after a long gap.
				growthRow({ id: "x1", timestamp: 0, project: "proj-x" }),
				growthRow({ id: "x2", timestamp: 5 * MINUTE, project: "proj-x" }),
				growthRow({
					id: "x3",
					timestamp: 5 * MINUTE + gap + 1,
					project: "proj-x",
				}),
				// proj-y (null project): independent session.
				growthRow({ id: "y1", timestamp: 2 * MINUTE, project: null }),
			],
		});

		const sessions = response.growthCurve.sessions;
		expect(sessions).toHaveLength(3);
		// Most recent session (by endTimestamp) first.
		expect(sessions[0].points.map((p) => p.requestId)).toEqual(["x3"]);
		expect(sessions[1].points.map((p) => p.requestId)).toEqual(["x1", "x2"]);
		expect(sessions[2].points.map((p) => p.requestId)).toEqual(["y1"]);

		const first = sessions[1];
		expect(first.project).toBe("proj-x");
		expect(first.startTimestamp).toBe(0);
		expect(first.endTimestamp).toBe(5 * MINUTE);
		expect(first.requestCount).toBe(2);
		// contextTokens = input + cache_read + cache_creation.
		expect(first.points[0].contextTokens).toBe(60);
		expect(first.points[0].outputTokens).toBe(5);
		expect(sessions[2].project).toBeNull();
		expect(response.growthCurve.truncated).toBe(false);
	});

	test("a gap exactly at the threshold does not split", () => {
		const gap = 10 * MINUTE;
		const response = build({
			growthRows: [
				growthRow({ id: "a", timestamp: 0 }),
				growthRow({ id: "b", timestamp: gap }),
			],
			sessionGapMinutes: 10,
		});
		expect(response.growthCurve.sessions).toHaveLength(1);
	});

	test("caps points per session, keeping the most recent points", () => {
		const rows = Array.from(
			{ length: MAX_POINTS_PER_SESSION + 1 },
			(_, index) => growthRow({ id: `p${index}`, timestamp: index * 1_000 }),
		);
		const response = build({ growthRows: rows });
		const session = response.growthCurve.sessions[0];
		expect(session.points).toHaveLength(MAX_POINTS_PER_SESSION);
		expect(session.points[0].requestId).toBe("p1"); // oldest point dropped
		expect(session.requestCount).toBe(MAX_POINTS_PER_SESSION + 1);
		expect(response.growthCurve.truncated).toBe(true);
	});

	test("caps the number of sessions, keeping the most recent by endTimestamp", () => {
		const rows = Array.from({ length: MAX_GROWTH_SESSIONS + 2 }, (_, index) =>
			growthRow({
				id: `s${index}`,
				timestamp: index * 1_000,
				project: `proj-${index}`,
			}),
		);
		const response = build({ growthRows: rows });
		expect(response.growthCurve.sessions).toHaveLength(MAX_GROWTH_SESSIONS);
		// The two oldest sessions are dropped.
		expect(
			response.growthCurve.sessions.some((s) => s.project === "proj-0"),
		).toBe(false);
		expect(
			response.growthCurve.sessions.some((s) => s.project === "proj-1"),
		).toBe(false);
		expect(response.growthCurve.truncated).toBe(true);
	});

	test("propagates the growth scan truncation flag", () => {
		const response = build({
			growthRows: [growthRow()],
			growthScanTruncated: true,
		});
		expect(response.growthCurve.truncated).toBe(true);
	});
});
