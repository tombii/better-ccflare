import { describe, expect, test } from "bun:test";
import {
	buildWebSearchErrorResponse,
	buildWebSearchResponse,
	type WebSearchToolErrorCode,
} from "../responder";
import type { DetectedWebSearchRequest, WebToolSearchHit } from "../types";

const HITS: WebToolSearchHit[] = [
	{
		title: "Bun v1.4",
		url: "https://bun.com/blog/bun-v1.4",
		snippet: "Bun 1.4 is\nout with   new features.",
		publishedDate: "2026-10-01",
	},
	{
		title: "Release notes",
		url: "https://example.com/notes",
	},
];

const ERROR_CODES: WebSearchToolErrorCode[] = [
	"unavailable",
	"too_many_requests",
	"invalid_tool_input",
	"max_uses_exceeded",
];

function detected(
	overrides: Partial<DetectedWebSearchRequest> = {},
): DetectedWebSearchRequest {
	return {
		query: "latest bun release",
		maxUses: 8,
		toolType: "web_search_20250305",
		stream: true,
		model: "claude-sonnet-5-5",
		...overrides,
	};
}

interface ParsedEvent {
	event: string;
	// biome-ignore lint/suspicious/noExplicitAny: SSE payloads are heterogeneous; assertions narrow them as needed.
	data: any;
}

/** Loose view of the synthesised non-streaming message, for assertions only. */
interface JsonBlock {
	type: string;
	id?: string;
	tool_use_id?: string;
	text?: string;
	input?: { query: string };
	content?: { type: string; error_code?: string } | JsonBlock[];
}

interface JsonMessage {
	type: string;
	role: string;
	model: string;
	stop_reason: string | null;
	stop_sequence: string | null;
	content: JsonBlock[];
	usage: { server_tool_use: { web_search_requests: number } };
}

/** Split an SSE body into its events, parsing each `data:` line as JSON. */
async function parseSse(response: Response): Promise<ParsedEvent[]> {
	const text = await response.text();
	return text
		.split("\n\n")
		.filter((frame) => frame.trim().length > 0)
		.map((frame) => {
			const lines = frame.split("\n");
			const eventLine = lines.find((line) => line.startsWith("event: ")) ?? "";
			const dataLine = lines.find((line) => line.startsWith("data: ")) ?? "";
			return {
				event: eventLine.slice("event: ".length),
				data: JSON.parse(dataLine.slice("data: ".length)),
			};
		});
}

/** Concatenate the text_delta payloads, as a client would. */
function digestFrom(events: ParsedEvent[]): string {
	return events
		.filter(
			({ data }) =>
				data.type === "content_block_delta" &&
				data.delta?.type === "text_delta",
		)
		.map(({ data }) => data.delta.text as string)
		.join("");
}

describe("buildWebSearchResponse (streaming)", () => {
	test("emits the Anthropic SSE event sequence with SSE headers", async () => {
		const response = buildWebSearchResponse({
			request: detected(),
			hits: HITS,
			maxResultChars: 4000,
		});

		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.headers.get("cache-control")).toBe("no-cache");
		expect(response.headers.get("connection")).toBe("keep-alive");

		const events = await parseSse(response);
		expect(events.map(({ event }) => event)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_stop",
			"content_block_start",
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		// The SSE event name and the payload's own `type` agree.
		expect(events.map(({ data }) => data.type)).toEqual(
			events.map(({ event }) => event),
		);
	});

	test("message_start carries the request model and empty usage", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: HITS,
				maxResultChars: 4000,
			}),
		);

		const message = events[0].data.message;
		expect(message.id.startsWith("msg_")).toBe(true);
		expect(message.type).toBe("message");
		expect(message.role).toBe("assistant");
		expect(message.model).toBe("claude-sonnet-5-5");
		expect(message.content).toEqual([]);
		expect(message.stop_reason).toBeNull();
		expect(message.stop_sequence).toBeNull();
		expect(message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
	});

	test("content blocks use indices 0, 1, 2 and share the tool-use id", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: HITS,
				maxResultChars: 4000,
			}),
		);

		const serverToolUse = events[1].data;
		const toolResult = events[3].data;
		const textStart = events[5].data;

		expect(serverToolUse.index).toBe(0);
		expect(serverToolUse.content_block.type).toBe("server_tool_use");
		expect(serverToolUse.content_block.name).toBe("web_search");
		expect(serverToolUse.content_block.input).toEqual({
			query: "latest bun release",
		});
		expect(serverToolUse.content_block.id.startsWith("srvtoolu_")).toBe(true);

		expect(toolResult.index).toBe(1);
		expect(toolResult.content_block.type).toBe("web_search_tool_result");
		expect(toolResult.content_block.tool_use_id).toBe(
			serverToolUse.content_block.id,
		);
		expect(Array.isArray(toolResult.content_block.content)).toBe(true);

		expect(textStart.index).toBe(2);
		expect(textStart.content_block).toEqual({ type: "text", text: "" });

		expect(events[2].data).toEqual({ type: "content_block_stop", index: 0 });
		expect(events[4].data).toEqual({ type: "content_block_stop", index: 1 });
		expect(events[7].data).toEqual({ type: "content_block_stop", index: 2 });
	});

	test("result entries carry title, url and optional page_age", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: HITS,
				maxResultChars: 4000,
			}),
		);
		const results = events[3].data.content_block.content;

		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			type: "web_search_result",
			title: "Bun v1.4",
			url: "https://bun.com/blog/bun-v1.4",
			page_age: "2026-10-01",
		});
		expect(results[1]).toEqual({
			type: "web_search_result",
			title: "Release notes",
			url: "https://example.com/notes",
		});
	});

	test("message_delta ends the turn and reports one web search", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: HITS,
				maxResultChars: 4000,
			}),
		);
		const delta = events[8].data;

		expect(delta.delta).toEqual({
			stop_reason: "end_turn",
			stop_sequence: null,
		});
		expect(delta.usage.server_tool_use.web_search_requests).toBe(1);
		expect(delta.usage.output_tokens).toBeGreaterThan(0);
		expect(events[9].data).toEqual({ type: "message_stop" });
	});

	test("digest is numbered plain text with collapsed snippets", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: HITS,
				maxResultChars: 4000,
			}),
		);
		const digest = digestFrom(events);

		expect(
			digest.startsWith('Web search results for: "latest bun release"'),
		).toBe(true);
		expect(digest).toContain("1. Bun v1.4");
		expect(digest).toContain("\n   https://bun.com/blog/bun-v1.4");
		expect(digest).toContain("Bun 1.4 is out with new features.");
		expect(digest).toContain("2. Release notes");
		expect(digest).not.toContain("|");
	});

	test("round-trips through a Claude Code-style parser", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: HITS,
				maxResultChars: 4000,
			}),
		);

		const blocks: unknown[] = [];
		let text = "";
		for (const { data } of events) {
			if (data.type === "content_block_start") {
				blocks[data.index] = data.content_block;
			} else if (
				data.type === "content_block_delta" &&
				data.delta?.type === "text_delta"
			) {
				text += data.delta.text;
			}
		}

		const serverToolUse = blocks.find(
			(block): block is { type: string; input: { query: string } } =>
				(block as { type?: string })?.type === "server_tool_use",
		);
		expect(serverToolUse?.input.query).toBe("latest bun release");

		const resultBlock = blocks.find(
			(block): block is { type: string; content: unknown } =>
				(block as { type?: string })?.type === "web_search_tool_result",
		);
		expect(Array.isArray(resultBlock?.content)).toBe(true);
		expect(text.trim().length).toBeGreaterThan(0);
	});

	test("truncates the digest to maxResultChars with the marker", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: [
					{
						title: "Long page",
						url: "https://example.com/long",
						snippet: "x".repeat(5000),
					},
				],
				maxResultChars: 200,
			}),
		);
		const digest = digestFrom(events);

		expect(digest.length).toBeLessThanOrEqual(200);
		expect(digest.endsWith("…[truncated]")).toBe(true);
	});

	test("caps an individual long snippet even when the digest fits", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: [
					{
						title: "Long page",
						url: "https://example.com/long",
						snippet: "y".repeat(5000),
					},
				],
				maxResultChars: 10_000,
			}),
		);
		const digest = digestFrom(events);
		const snippetLine = digest
			.split("\n")
			.find((line) => line.trim().startsWith("y"));

		expect(digest.endsWith("…[truncated]")).toBe(false);
		expect(snippetLine?.trim().length).toBeLessThanOrEqual(501);
	});

	test("empty hits produce a no-results digest, not an empty block", async () => {
		const events = await parseSse(
			buildWebSearchResponse({
				request: detected(),
				hits: [],
				maxResultChars: 4000,
			}),
		);
		const digest = digestFrom(events);

		expect(digest.length).toBeGreaterThan(0);
		expect(digest).toContain("No results were found for this search.");
	});
});

describe("buildWebSearchResponse (non-streaming)", () => {
	test("returns a JSON message with the three blocks in order", async () => {
		const response = buildWebSearchResponse({
			request: detected({ stream: false }),
			hits: HITS,
			maxResultChars: 4000,
		});

		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("cache-control")).toBe("no-cache");

		const message = (await response.json()) as JsonMessage;
		expect(message.type).toBe("message");
		expect(message.role).toBe("assistant");
		expect(message.model).toBe("claude-sonnet-5-5");
		expect(message.stop_reason).toBe("end_turn");
		expect(message.stop_sequence).toBeNull();
		expect(message.content.map((block) => block.type)).toEqual([
			"server_tool_use",
			"web_search_tool_result",
			"text",
		]);
		expect(message.content[0].input).toEqual({ query: "latest bun release" });
		expect(message.content[1].tool_use_id).toBe(message.content[0].id);
		expect(message.content[2].text.length).toBeGreaterThan(0);
		expect(message.usage.server_tool_use.web_search_requests).toBe(1);
	});
});

describe("buildWebSearchErrorResponse", () => {
	test("non-streaming errors carry a single error object, not an array", async () => {
		for (const errorCode of ERROR_CODES) {
			const response = buildWebSearchErrorResponse(
				detected({ stream: false }),
				errorCode,
			);
			const message = (await response.json()) as JsonMessage;
			const result = message.content[1];
			const errorContent = result.content as {
				type: string;
				error_code?: string;
			};

			expect(result.type).toBe("web_search_tool_result");
			expect(Array.isArray(result.content)).toBe(false);
			expect(errorContent.type).toBe("web_search_tool_result_error");
			expect(errorContent.error_code).toBe(errorCode);
			expect(message.content.map((block) => block.type)).toEqual([
				"server_tool_use",
				"web_search_tool_result",
				"text",
			]);
			expect(message.content[2].text.length).toBeGreaterThan(0);
			// Explanations stay generic: no URLs, provider names or keys.
			expect(message.content[2].text).not.toContain("http");
		}
	});

	test("streaming errors keep the SSE envelope and the object content", async () => {
		const events = await parseSse(
			buildWebSearchErrorResponse(detected(), "unavailable"),
		);

		expect(events).toHaveLength(10);
		expect(events[0].event).toBe("message_start");
		expect(events[9].event).toBe("message_stop");
		expect(events[3].data.content_block.content).toEqual({
			type: "web_search_tool_result_error",
			error_code: "unavailable",
		});
		expect(events[8].data.usage.server_tool_use.web_search_requests).toBe(1);
		expect(digestFrom(events).length).toBeGreaterThan(0);
	});
});
