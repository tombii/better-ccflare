/**
 * Synthesise the Anthropic Messages response Claude Code expects from a local
 * `web_search` interception. See `types.ts` for the background.
 *
 * The shape here is a wire contract with Claude Code's parser, not a general
 * Anthropic encoder: the tool_use block's `input` is written inline (Claude
 * Code falls back to the original query when no `input_json_delta` arrives),
 * and `web_search_tool_result.content` is an array of results on success but a
 * SINGLE error object on failure — the parser branches on `Array.isArray`.
 */

import { jsonResponse, sseResponse } from "@better-ccflare/http-common";
import type {
	DetectedWebSearchRequest,
	WebSearchResponseArgs,
	WebToolSearchHit,
} from "./types";

const encoder = new TextEncoder();

/** Per-snippet cap, keeping one verbose page from dominating the digest. */
const SNIPPET_MAX_CHARS = 500;

/** Marker appended when the digest is trimmed to `maxResultChars`. */
const TRUNCATION_SUFFIX = "…[truncated]";

const NO_RESULTS_TEXT = "No results were found for this search.";

/** Anthropic's `web_search_tool_result_error.error_code` vocabulary. */
export type WebSearchToolErrorCode =
	| "unavailable"
	| "too_many_requests"
	| "invalid_tool_input"
	| "max_uses_exceeded";

/**
 * Client-facing explanation per error code. Deliberately generic: provider
 * names, URLs and keys must never reach the client's transcript.
 */
const ERROR_TEXT: Record<WebSearchToolErrorCode, string> = {
	unavailable: "Web search is currently unavailable. Please try again later.",
	too_many_requests:
		"Web search is rate limited right now. Please try again shortly.",
	invalid_tool_input: "The web search request was rejected as invalid.",
	max_uses_exceeded:
		"The web search limit for this request was reached before a result could be returned.",
};

function randomAnthropicId(prefix: string): string {
	return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Trim a single snippet, marking the cut so the model knows it is partial. */
function truncateSnippet(text: string): string {
	if (text.length <= SNIPPET_MAX_CHARS) return text;
	return `${text.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

/** Trim the whole digest to `maxChars`, never exceeding it. */
function truncateDigest(digest: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (digest.length <= maxChars) return digest;
	if (maxChars <= TRUNCATION_SUFFIX.length) {
		return TRUNCATION_SUFFIX.slice(0, maxChars);
	}
	return `${digest.slice(0, maxChars - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

/**
 * Plain-text, numbered digest of the results. Empty hit lists still produce a
 * sentence so the text block is never empty.
 */
function buildDigest(
	query: string,
	hits: WebToolSearchHit[],
	maxResultChars: number,
): string {
	const header = `Web search results for: "${query}"`;
	if (hits.length === 0) {
		return truncateDigest(`${header}\n\n${NO_RESULTS_TEXT}`, maxResultChars);
	}

	const lines: string[] = [header, ""];
	hits.forEach((hit, index) => {
		const title = collapseWhitespace(hit.title) || hit.url.trim();
		lines.push(`${index + 1}. ${title}`);
		lines.push(`   ${hit.url.trim()}`);

		// `content` is a fallback for adapters that return extracted page text
		// instead of a short snippet.
		const snippetSource = hit.snippet ?? hit.content;
		if (snippetSource) {
			const snippet = truncateSnippet(collapseWhitespace(snippetSource));
			if (snippet.length > 0) lines.push(`   ${snippet}`);
		}
	});
	return truncateDigest(lines.join("\n"), maxResultChars);
}

/** Coarse output-token estimate for the synthesised text. */
function estimateOutputTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function buildServerToolUseBlock(
	request: DetectedWebSearchRequest,
	toolUseId: string,
): Record<string, unknown> {
	return {
		type: "server_tool_use",
		id: toolUseId,
		name: "web_search",
		input: { query: request.query },
	};
}

/**
 * The tool-result block. `content` is either the result array or the single
 * error object; the distinction is the signal Claude Code's parser uses.
 */
function buildToolResultBlock(
	toolUseId: string,
	content: unknown,
): Record<string, unknown> {
	return {
		type: "web_search_tool_result",
		tool_use_id: toolUseId,
		content,
	};
}

function buildResultContent(
	hits: WebToolSearchHit[],
): Record<string, unknown>[] {
	return hits.map((hit) => {
		const result: Record<string, unknown> = {
			type: "web_search_result",
			title: hit.title,
			url: hit.url,
		};
		if (hit.publishedDate) result.page_age = hit.publishedDate;
		return result;
	});
}

function sseFrame(eventType: string, payload: unknown): string {
	return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseResponseFromString(body: string): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return sseResponse(stream);
}

function buildStreamingResponse(
	request: DetectedWebSearchRequest,
	serverToolUse: Record<string, unknown>,
	toolResult: Record<string, unknown>,
	digest: string,
): Response {
	const outputTokens = estimateOutputTokens(digest);
	const frames = [
		sseFrame("message_start", {
			type: "message_start",
			message: {
				id: randomAnthropicId("msg_"),
				type: "message",
				role: "assistant",
				model: request.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		}),
		sseFrame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: serverToolUse,
		}),
		sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
		sseFrame("content_block_start", {
			type: "content_block_start",
			index: 1,
			content_block: toolResult,
		}),
		sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
		sseFrame("content_block_start", {
			type: "content_block_start",
			index: 2,
			content_block: { type: "text", text: "" },
		}),
		sseFrame("content_block_delta", {
			type: "content_block_delta",
			index: 2,
			delta: { type: "text_delta", text: digest },
		}),
		sseFrame("content_block_stop", { type: "content_block_stop", index: 2 }),
		sseFrame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: {
				output_tokens: outputTokens,
				server_tool_use: { web_search_requests: 1 },
			},
		}),
		sseFrame("message_stop", { type: "message_stop" }),
	];
	return sseResponseFromString(frames.join(""));
}

function buildJsonResponse(
	request: DetectedWebSearchRequest,
	serverToolUse: Record<string, unknown>,
	toolResult: Record<string, unknown>,
	digest: string,
): Response {
	const message = {
		id: randomAnthropicId("msg_"),
		type: "message",
		role: "assistant",
		model: request.model,
		content: [serverToolUse, toolResult, { type: "text", text: digest }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: estimateOutputTokens(digest),
			server_tool_use: { web_search_requests: 1 },
		},
	};
	return jsonResponse(message, 200, { "Cache-Control": "no-cache" });
}

function buildResponse(
	request: DetectedWebSearchRequest,
	resultContent: unknown,
	digest: string,
): Response {
	const toolUseId = randomAnthropicId("srvtoolu_");
	const serverToolUse = buildServerToolUseBlock(request, toolUseId);
	const toolResult = buildToolResultBlock(toolUseId, resultContent);

	return request.stream
		? buildStreamingResponse(request, serverToolUse, toolResult, digest)
		: buildJsonResponse(request, serverToolUse, toolResult, digest);
}

/**
 * Build the successful Anthropic response for a completed local search.
 * Streaming requests get Anthropic SSE; everything else gets a JSON message.
 */
export function buildWebSearchResponse(args: WebSearchResponseArgs): Response {
	const { request, hits, maxResultChars } = args;
	return buildResponse(
		request,
		buildResultContent(hits),
		buildDigest(request.query, hits, maxResultChars),
	);
}

/**
 * Build the in-band failure response. Anthropic reports tool failures inside a
 * normal message, so this is still a 200 with the usual envelope; only the
 * tool-result block's `content` changes to a single error object.
 */
export function buildWebSearchErrorResponse(
	request: DetectedWebSearchRequest,
	errorCode: WebSearchToolErrorCode,
): Response {
	return buildResponse(
		request,
		{ type: "web_search_tool_result_error", error_code: errorCode },
		ERROR_TEXT[errorCode],
	);
}
