/**
 * Extraction of Claude Code's opt-in "gateway hint" request headers.
 *
 * Claude Code CLI >= 2.1.273 can send five headers to an LLM gateway when the
 * client sets `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`:
 *
 *   x-claude-code-request-class
 *   x-claude-code-agent-type
 *   x-claude-code-prev-tool-durations
 *   x-claude-code-compaction
 *   x-claude-code-context-compacted
 *
 * These are pure observability metadata — better-ccflare never reads them to
 * make a routing or rewrite decision, so (unlike project/agent attribution)
 * there is no need to thread them through `RequestMeta`/`StartMessage` ahead
 * of time. They are captured directly from the raw request-header map that
 * already accompanies every `StartMessage` (see usage-collector.ts).
 *
 * Absence is the normal case: the opt-in env var is off by default, and older
 * Claude Code versions never send these headers at all. Every field is
 * therefore nullable and extraction never throws — a missing or malformed
 * header degrades to `null`, never an error or a behavior change.
 */

/** Header accessor working uniformly over a `Headers` instance or a
 * lower-cased `Record<string, string>` map (mirrors project-attribution.ts's
 * `getHeader` pattern). */
export type HeaderGetter = (name: string) => string | null | undefined;

export interface GatewayHintHeaders {
	requestClass: string | null;
	agentType: string | null;
	prevToolDurations: string | null;
	compaction: string | null;
	contextCompacted: string | null;
}

// Short enum/flag-shaped values (e.g. "primary", "subagent", "true").
const HEADER_VALUE_MAX_LEN = 256;
// `x-claude-code-prev-tool-durations` is plausibly a JSON-encoded array of
// per-tool-call durations, so it gets a generous cap rather than the short
// one above — bounded all the same so a hostile/buggy client cannot grow
// every row without limit.
const PREV_TOOL_DURATIONS_MAX_LEN = 2048;

function readHeader(
	getHeader: HeaderGetter,
	name: string,
	maxLen: number,
): string | null {
	const raw = getHeader(name);
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/**
 * Core extraction, parameterized over a header accessor so the same logic
 * works for both the proxy's `Headers` object and the usage collector's
 * `Record<string, string>` header map.
 */
export function extractGatewayHintHeaders(
	getHeader: HeaderGetter,
): GatewayHintHeaders {
	return {
		requestClass: readHeader(
			getHeader,
			"x-claude-code-request-class",
			HEADER_VALUE_MAX_LEN,
		),
		agentType: readHeader(
			getHeader,
			"x-claude-code-agent-type",
			HEADER_VALUE_MAX_LEN,
		),
		prevToolDurations: readHeader(
			getHeader,
			"x-claude-code-prev-tool-durations",
			PREV_TOOL_DURATIONS_MAX_LEN,
		),
		compaction: readHeader(
			getHeader,
			"x-claude-code-compaction",
			HEADER_VALUE_MAX_LEN,
		),
		contextCompacted: readHeader(
			getHeader,
			"x-claude-code-context-compacted",
			HEADER_VALUE_MAX_LEN,
		),
	};
}

/** Convenience wrapper for a real `Headers` instance (proxy request path). */
export function extractGatewayHintHeadersFromRequest(
	headers: Headers,
): GatewayHintHeaders {
	return extractGatewayHintHeaders((n) => headers.get(n));
}

/**
 * Convenience wrapper for the usage collector's `StartMessage`-shaped input,
 * where headers arrive as a plain `Record<string, string>` (already present
 * on every `StartMessage` regardless of which code path constructed it).
 */
export function extractGatewayHintHeadersFromParts(
	requestHeaders: Record<string, string> | null | undefined,
): GatewayHintHeaders {
	const headerMap: Record<string, string> = {};
	if (requestHeaders) {
		for (const [key, value] of Object.entries(requestHeaders)) {
			headerMap[key.toLowerCase()] = value;
		}
	}
	return extractGatewayHintHeaders((n) => headerMap[n.toLowerCase()]);
}
