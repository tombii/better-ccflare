/**
 * Official xAI context windows for Grok 4.5 / 4.6 (docs.x.ai: 500,000 tokens).
 * Original grok-4 is intentionally absent — it is a different, smaller window
 * and must not inherit 500k via a `grok-4` prefix match on `grok-4.6`.
 */
const XAI_CONTEXT_WINDOW_BY_FAMILY: Readonly<Record<string, number>> = {
	"grok-4.6": 500_000,
	"grok-4.5": 500_000,
};
const XAI_CONTEXT_WINDOW_FAMILIES = Object.keys(
	XAI_CONTEXT_WINDOW_BY_FAMILY,
).sort((a, b) => b.length - a.length);

export interface XaiContextWindowResolution {
	family: string;
	contextWindow: number;
	match: "exact" | "prefix";
}

export function resolveXaiContextWindow(
	model: string,
): XaiContextWindowResolution | undefined {
	if (typeof model !== "string" || model.length === 0) return undefined;
	const exact = XAI_CONTEXT_WINDOW_BY_FAMILY[model];
	if (exact !== undefined) {
		return { family: model, contextWindow: exact, match: "exact" };
	}
	const family =
		XAI_CONTEXT_WINDOW_FAMILIES.find((key) => model.startsWith(`${key}-`)) ??
		"";
	const contextWindow = family
		? XAI_CONTEXT_WINDOW_BY_FAMILY[family]
		: undefined;
	if (contextWindow === undefined) return undefined;
	return { family, contextWindow, match: "prefix" };
}
