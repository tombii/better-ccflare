import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { APIContext } from "../../types";
import { createContextInsightsHandler } from "../insights";

/**
 * Integration tests for GET /api/insights/context against a real in-memory
 * SQLite database, seeding requests + request_payloads with realistic
 * base64-wrapped Anthropic bodies.
 */

const SONNET = "claude-sonnet-4-20250514";

/** Wrap a provider request body the way the proxy stores it. */
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

const SYSTEM_PROMPT = "You are a helpful assistant with detailed instructions.";
const TOOLS = [{ name: "Bash", input_schema: { type: "object" } }];
const BIG_TOOL_OUTPUT = "tool output line\n".repeat(60); // > 512 chars

/** Anthropic-format body used by most seeded payloads. */
function anthropicBody(userText: string): unknown {
	return {
		model: SONNET,
		system: SYSTEM_PROMPT,
		tools: TOOLS,
		messages: [
			{ role: "user", content: userText },
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
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: BIG_TOOL_OUTPUT,
					},
				],
			},
		],
	};
}

/** Expected char breakdown for an anthropicBody payload. */
function expectedChars(userText: string): {
	system: number;
	tools: number;
	messages: number;
} {
	const body = anthropicBody(userText) as {
		system: unknown;
		tools: unknown;
		messages: unknown;
	};
	return {
		system: JSON.stringify(body.system).length,
		tools: JSON.stringify(body.tools).length,
		messages: JSON.stringify(body.messages).length,
	};
}

describe("context insights handler (SQLite integration)", () => {
	let db: Database;
	let context: APIContext;
	let now: number;

	function insertRequest(opts: {
		id: string;
		timestamp: number;
		accountUsed?: string | null;
		model?: string | null;
		project?: string | null;
		inputTokens?: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		outputTokens?: number;
	}): void {
		db.run(
			`INSERT INTO requests
				(id, timestamp, method, path, account_used, status_code, success,
				 response_time_ms, failover_attempts, model, input_tokens,
				 cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
				 project)
			 VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 100, 0, ?, ?, ?, ?, ?, ?)`,
			[
				opts.id,
				opts.timestamp,
				opts.accountUsed ?? "a1",
				opts.model ?? SONNET,
				opts.inputTokens ?? 0,
				opts.cacheReadTokens ?? 0,
				opts.cacheCreationTokens ?? 0,
				opts.outputTokens ?? 0,
				opts.project ?? null,
			],
		);
	}

	function insertPayload(id: string, json: string, timestamp: number): void {
		db.run(
			"INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)",
			[id, json, timestamp],
		);
	}

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('a1', 'acct-A', ?)",
			[Date.now()],
		);
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('a2', 'acct-B', ?)",
			[Date.now()],
		);

		now = Date.now();

		const adapter = new BunSqlAdapter(db);
		context = {
			db: adapter,
			config: {} as APIContext["config"],
			dbOps: {
				getAdapter: () => adapter,
				// Mirrors RequestRepository.getPayload: parsed wrapper or null
				// when the row is missing or its json is malformed.
				getRequestPayload: async (id: string) => {
					const rows = await adapter.query<{ json: string }>(
						"SELECT json FROM request_payloads WHERE id = ?",
						[id],
					);
					if (!rows[0]) return null;
					try {
						return JSON.parse(rows[0].json);
					} catch {
						return null;
					}
				},
			} as unknown as APIContext["dbOps"],
		};
	});

	afterEach(() => {
		db.close();
	});

	it("reports coverage, composition sums and exact token totals", async () => {
		// r1 + r2 have payloads; r3 has none (coverage gap); r4 is out of range.
		insertRequest({
			id: "r1",
			timestamp: now - 3_000,
			inputTokens: 100,
			cacheReadTokens: 1_000,
			cacheCreationTokens: 10,
			outputTokens: 50,
			project: "proj-x",
		});
		insertPayload("r1", wrapBody(anthropicBody("first request")), now - 3_000);
		insertRequest({
			id: "r2",
			timestamp: now - 2_000,
			inputTokens: 200,
			cacheReadTokens: 2_000,
			cacheCreationTokens: 20,
			outputTokens: 60,
			project: "proj-x",
		});
		insertPayload("r2", wrapBody(anthropicBody("second request")), now - 2_000);
		insertRequest({ id: "r3", timestamp: now - 1_000, inputTokens: 999 });
		insertRequest({ id: "r4", timestamp: now - 2 * 24 * 60 * 60 * 1000 });
		insertPayload("r4", wrapBody(anthropicBody("old")), now);

		const response = await createContextInsightsHandler(context)(
			new URLSearchParams(),
		);
		expect(response.status).toBe(200);
		const data = await response.json();

		expect(data.meta.range).toBe("24h");
		expect(data.meta.payloadCoverage).toEqual({
			requestsInRange: 3,
			requestsWithPayload: 2,
		});
		expect(data.meta.scannedPayloads).toBe(2);
		expect(data.meta.parsedPayloads).toBe(2);
		expect(data.meta.unparseablePayloads).toBe(0);
		expect(data.meta.truncated).toBe(false);
		expect(typeof data.meta.estimateNote).toBe("string");
		expect(data.meta.estimateNote).toContain("~4 chars/token");

		// Hand-computed char sums over r1 + r2.
		const c1 = expectedChars("first request");
		const c2 = expectedChars("second request");
		expect(data.composition.totals.systemChars).toBe(c1.system + c2.system);
		expect(data.composition.totals.toolsChars).toBe(c1.tools + c2.tools);
		expect(data.composition.totals.messagesChars).toBe(
			c1.messages + c2.messages,
		);

		// Exact token sums over the parsed requests (r3 excluded: no payload).
		expect(data.composition.tokenTotals).toEqual({
			uncachedInputTokens: 300,
			cacheReadInputTokens: 3_000,
			cacheCreationInputTokens: 30,
		});

		// perRequest: most recent first, with account name resolved.
		expect(
			data.composition.perRequest.map((r: { id: string }) => r.id),
		).toEqual(["r2", "r1"]);
		expect(data.composition.perRequest[0].account).toBe("acct-A");
		expect(data.composition.perRequest[0].project).toBe("proj-x");

		// The large tool_result appears in both requests with the same content,
		// so it groups into one contributor seen twice.
		const toolResult = data.topContributors.find(
			(c: { kind: string }) => c.kind === "tool_result",
		);
		expect(toolResult).toBeDefined();
		expect(toolResult.label).toBe("Bash");
		expect(toolResult.occurrences).toBe(2);
		expect(toolResult.requestCount).toBe(2);
	});

	it("counts unparseable payloads without failing the request", async () => {
		insertRequest({ id: "ok", timestamp: now - 2_000 });
		insertPayload("ok", wrapBody(anthropicBody("fine")), now - 2_000);
		// Wrapper parses but the body is invalid base64 garbage.
		insertRequest({ id: "bad-body", timestamp: now - 1_500 });
		insertPayload(
			"bad-body",
			JSON.stringify({ request: { headers: {}, body: "!!!not-base64!!!" } }),
			now - 1_500,
		);
		// The json column itself is not JSON (e.g. encrypted at rest).
		insertRequest({ id: "bad-json", timestamp: now - 1_000 });
		insertPayload("bad-json", "enc:deadbeef", now - 1_000);

		const response = await createContextInsightsHandler(context)(
			new URLSearchParams(),
		);
		expect(response.status).toBe(200);
		const data = await response.json();

		expect(data.meta.scannedPayloads).toBe(3);
		expect(data.meta.parsedPayloads).toBe(1);
		expect(data.meta.unparseablePayloads).toBe(2);
		expect(
			data.composition.perRequest.map((r: { id: string }) => r.id),
		).toEqual(["ok"]);
	});

	it("applies the scan limit and sets truncated, analyzing the most recent payloads", async () => {
		for (let index = 0; index < 3; index++) {
			const id = `r${index}`;
			insertRequest({ id, timestamp: now - (3 - index) * 1_000 });
			insertPayload(id, wrapBody(anthropicBody(`request ${index}`)), now);
		}

		const response = await createContextInsightsHandler(context)(
			new URLSearchParams("limit=2"),
		);
		const data = await response.json();

		expect(data.meta.scannedPayloads).toBe(2);
		expect(data.meta.truncated).toBe(true);
		// Most recent two: r2 then r1.
		expect(
			data.composition.perRequest.map((r: { id: string }) => r.id),
		).toEqual(["r2", "r1"]);
		// Coverage is unaffected by the scan limit.
		expect(data.meta.payloadCoverage).toEqual({
			requestsInRange: 3,
			requestsWithPayload: 3,
		});
	});

	it("clamps the limit param to the allowed range", async () => {
		insertRequest({ id: "r1", timestamp: now - 1_000 });
		insertPayload("r1", wrapBody(anthropicBody("hi")), now);

		// limit=0 clamps to 1; nonsense falls back to the default — both succeed.
		const zero = await createContextInsightsHandler(context)(
			new URLSearchParams("limit=0"),
		);
		expect(zero.status).toBe(200);
		const nonsense = await createContextInsightsHandler(context)(
			new URLSearchParams("limit=abc"),
		);
		expect(nonsense.status).toBe(200);
		const data = await nonsense.json();
		expect(data.meta.scannedPayloads).toBe(1);
	});

	it("applies the shared account filter to coverage, payloads and growth", async () => {
		insertRequest({ id: "mine", timestamp: now - 2_000, accountUsed: "a1" });
		insertPayload("mine", wrapBody(anthropicBody("mine")), now);
		insertRequest({ id: "theirs", timestamp: now - 1_000, accountUsed: "a2" });
		insertPayload("theirs", wrapBody(anthropicBody("theirs")), now);

		const response = await createContextInsightsHandler(context)(
			new URLSearchParams("accounts=acct-A"),
		);
		const data = await response.json();

		expect(data.meta.payloadCoverage).toEqual({
			requestsInRange: 1,
			requestsWithPayload: 1,
		});
		expect(
			data.composition.perRequest.map((r: { id: string }) => r.id),
		).toEqual(["mine"]);
		const allPoints = data.growthCurve.sessions.flatMap(
			(s: { points: Array<{ requestId: string }> }) => s.points,
		);
		expect(allPoints.map((p: { requestId: string }) => p.requestId)).toEqual([
			"mine",
		]);
	});

	it("builds growth sessions from exact token columns, split by gap and project", async () => {
		const MINUTE = 60_000;
		// proj-x: two close requests, then one past the 30-minute default gap.
		insertRequest({
			id: "x1",
			timestamp: now - 120 * MINUTE,
			project: "proj-x",
			inputTokens: 10,
			cacheReadTokens: 100,
			cacheCreationTokens: 1,
			outputTokens: 7,
		});
		insertRequest({
			id: "x2",
			timestamp: now - 115 * MINUTE,
			project: "proj-x",
			inputTokens: 20,
			cacheReadTokens: 200,
			cacheCreationTokens: 2,
			outputTokens: 8,
		});
		insertRequest({
			id: "x3",
			timestamp: now - 60 * MINUTE,
			project: "proj-x",
			inputTokens: 30,
			cacheReadTokens: 300,
			cacheCreationTokens: 3,
			outputTokens: 9,
		});
		// Different project inside the same window: its own session.
		insertRequest({
			id: "y1",
			timestamp: now - 110 * MINUTE,
			project: "proj-y",
		});
		// No payloads at all — the growth curve must not require them.

		const response = await createContextInsightsHandler(context)(
			new URLSearchParams(),
		);
		const data = await response.json();

		expect(data.meta.parsedPayloads).toBe(0);
		const sessions = data.growthCurve.sessions;
		expect(sessions).toHaveLength(3);
		// Most recent first by end timestamp: x3 alone (-60m), y1 (-110m),
		// then x1+x2 (ends -115m).
		expect(
			sessions.map((s: { points: Array<{ requestId: string }> }) =>
				s.points.map((p) => p.requestId),
			),
		).toEqual([["x3"], ["y1"], ["x1", "x2"]]);
		const early = sessions[2];
		expect(early.project).toBe("proj-x");
		expect(early.requestCount).toBe(2);
		expect(early.points[0].contextTokens).toBe(111); // 10 + 100 + 1
		expect(early.points[0].outputTokens).toBe(7);
		expect(data.growthCurve.truncated).toBe(false);
	});

	it("respects the sessionGapMinutes param", async () => {
		const MINUTE = 60_000;
		insertRequest({ id: "a", timestamp: now - 20 * MINUTE, project: "p" });
		insertRequest({ id: "b", timestamp: now - 5 * MINUTE, project: "p" });

		const wide = await (
			await createContextInsightsHandler(context)(new URLSearchParams())
		).json();
		expect(wide.growthCurve.sessions).toHaveLength(1);

		const narrow = await (
			await createContextInsightsHandler(context)(
				new URLSearchParams("sessionGapMinutes=10"),
			)
		).json();
		expect(narrow.growthCurve.sessions).toHaveLength(2);
	});

	it("respects the topContributors param", async () => {
		// Two distinct large text blocks in one payload.
		const bigA = "alpha ".repeat(200);
		const bigB = "beta ".repeat(300);
		insertRequest({ id: "r1", timestamp: now - 1_000 });
		insertPayload(
			"r1",
			wrapBody({
				messages: [
					{ role: "user", content: [{ type: "text", text: bigA }] },
					{ role: "user", content: [{ type: "text", text: bigB }] },
				],
			}),
			now,
		);

		const all = await (
			await createContextInsightsHandler(context)(new URLSearchParams())
		).json();
		expect(all.topContributors).toHaveLength(2);

		const capped = await (
			await createContextInsightsHandler(context)(
				new URLSearchParams("topContributors=1"),
			)
		).json();
		expect(capped.topContributors).toHaveLength(1);
		// Largest block wins.
		expect(capped.topContributors[0].label.startsWith("beta")).toBe(true);
	});

	it("returns a 500 error response when the query fails", async () => {
		const failing = {
			db: {} as APIContext["db"],
			config: {} as APIContext["config"],
			dbOps: {
				getAdapter: () => ({
					query: async () => {
						throw new Error("boom");
					},
				}),
			} as unknown as APIContext["dbOps"],
		};
		const response = await createContextInsightsHandler(failing)(
			new URLSearchParams(),
		);
		expect(response.status).toBe(500);
	});
});
