/**
 * Cache-related request telemetry.
 *
 * Anthropic cache breakpoints look back at most 20 content blocks to find a
 * prior cache entry. A single turn that appends more than 20 blocks (heavy
 * parallel tool fan-out: one tool_result block per call, plus text) can push
 * the previous turn's cached blocks out of the lookback window and cause a
 * silent full-prefix miss on the next request. The client owns breakpoint
 * placement, but the proxy is where the pattern is visible fleet-wide, so we
 * warn when a turn crosses the window.
 */
import { Logger } from "@better-ccflare/logger";
import type { RequestJsonBody } from "./handlers";

const log = new Logger("CacheTelemetry");

export const CACHE_LOOKBACK_WINDOW_BLOCKS = 20;

/**
 * Number of content blocks in the final message of the request, which is the
 * newly appended turn. String content counts as one block; malformed shapes
 * count as zero.
 */
export function trailingTurnBlockCount(body: RequestJsonBody | null): number {
	if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
		return 0;
	}
	const last = body.messages[body.messages.length - 1] as {
		content?: unknown;
	} | null;
	if (!last || typeof last !== "object") return 0;
	if (typeof last.content === "string") return 1;
	if (Array.isArray(last.content)) return last.content.length;
	return 0;
}

/** Warn (visible at production log level) when a turn exceeds the window. */
export function warnOnLookbackRisk(
	body: RequestJsonBody | null,
	sessionKey: string | null | undefined,
): void {
	const blocks = trailingTurnBlockCount(body);
	if (blocks > CACHE_LOOKBACK_WINDOW_BLOCKS) {
		log.warn(
			`final turn carries ${blocks} content blocks, above the ${CACHE_LOOKBACK_WINDOW_BLOCKS}-block cache lookback window; the next request in this conversation risks a silent full-prefix cache miss (session ${previewKey(sessionKey)})`,
		);
	}
}

function previewKey(key: string | null | undefined): string {
	if (!key) return "unknown";
	return key.length <= 24 ? key : `${key.slice(0, 24)}...`;
}
