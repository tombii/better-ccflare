/**
 * Recognise Claude Code's dedicated web-search sub-request.
 *
 * See `types.ts` for the background. Detection is deliberately conservative:
 * returning `null` merely lets the request go upstream as before, while a
 * false positive swallows a real request, so every uncertain case bails out.
 */

import type { DetectedWebSearchRequest, DetectOptions } from "./types";

/** Header that lets a caller opt a single request out of interception. */
const BYPASS_HEADER = "x-better-ccflare-web-tools";

/** Anthropic's default for `web_search` when the tool entry omits `max_uses`. */
const DEFAULT_MAX_USES = 8;

/**
 * Claude Code wraps the query in this sentence. The version string and the
 * surrounding whitespace move between releases, so tolerate both, as well as
 * an ASCII or full-width colon.
 */
const QUERY_PREFIX =
	/^\s*perform\s+a\s+web\s+search\s+for\s+the\s+query\s*[:：]?\s*/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only string members of a domain list; anything else is ignored. */
function toStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * True when `tool_choice` pins the model to a tool other than `web_search`.
 * `auto`, `any` and `none` don't name a tool, so they are compatible with the
 * helper shape; `{type:"tool", name}` does.
 */
function forcesOtherTool(toolChoice: unknown): boolean {
	if (!isRecord(toolChoice) || toolChoice.type !== "tool") return false;
	return toolChoice.name !== "web_search";
}

/**
 * Pull the prompt text out of the last user message. Returns `null` when no
 * user message exists or its content is neither a string nor a block array.
 */
function extractLastUserText(messages: unknown[]): string | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "user") continue;

		const content = message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return null;

		const texts: string[] = [];
		for (const block of content) {
			if (
				isRecord(block) &&
				block.type === "text" &&
				typeof block.text === "string"
			) {
				texts.push(block.text);
			}
		}
		return texts.join("\n");
	}
	return null;
}

/**
 * Detect the single-tool `web_search` helper request and extract its query.
 *
 * @returns the recognised request, or `null` when this is not (or not
 * certainly) the helper request.
 */
export function detectWebSearchRequest(
	body: unknown,
	options: DetectOptions,
): DetectedWebSearchRequest | null {
	if (options.enabled === false) return null;
	if (options.pathname !== "/v1/messages") return null;

	if (options.bypassHeaderEnabled !== false) {
		const bypass = options.headers?.get(BYPASS_HEADER)?.trim().toLowerCase();
		if (bypass === "off") return null;
	}

	if (!isRecord(body)) return null;

	const messages = body.messages;
	if (!Array.isArray(messages)) return null;

	// Exactly one tool: a real agent turn carries the model's full toolset, so
	// anything other than the lone server tool is not the helper request.
	const tools = body.tools;
	if (!Array.isArray(tools) || tools.length !== 1) return null;
	const tool = tools[0];
	if (
		!isRecord(tool) ||
		typeof tool.type !== "string" ||
		!tool.type.startsWith("web_search_")
	) {
		return null;
	}

	if (forcesOtherTool(body.tool_choice)) return null;

	const allowedDomains = toStringList(tool.allowed_domains);
	const blockedDomains = toStringList(tool.blocked_domains);
	// Anthropic rejects this combination itself; let upstream produce the real
	// validation error rather than masking it with a search.
	if (allowedDomains.length > 0 && blockedDomains.length > 0) return null;

	const rawQuery = extractLastUserText(messages);
	if (rawQuery === null) return null;

	const query = rawQuery.replace(QUERY_PREFIX, "").trim();
	if (query.length === 0) return null;

	const maxUses =
		typeof tool.max_uses === "number" &&
		Number.isFinite(tool.max_uses) &&
		tool.max_uses > 0
			? tool.max_uses
			: DEFAULT_MAX_USES;

	const detected: DetectedWebSearchRequest = {
		query,
		maxUses,
		toolType: tool.type,
		stream: body.stream === true,
		model: typeof body.model === "string" ? body.model : "",
	};
	if (allowedDomains.length > 0) detected.allowedDomains = allowedDomains;
	if (blockedDomains.length > 0) detected.blockedDomains = blockedDomains;
	return detected;
}
