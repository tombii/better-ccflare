import type {
	ApiKeyLimitEnforcement,
	ApiKeyResponse,
	ApiKeySpendWindow,
} from "@better-ccflare/types";
import {
	API_KEY_LIMIT_ENFORCEMENTS,
	API_KEY_SPEND_WINDOWS,
	DEFAULT_LIMIT_ENFORCEMENT,
	DEFAULT_SPEND_WINDOW,
} from "@better-ccflare/types";

/** The draft a limit editor works on. `limitUsd` is the text the user typed. */
export interface SpendLimitDraft {
	/** Raw input text, so a half-typed "1." does not vanish on re-render. */
	limitUsd: string;
	limitWindow: ApiKeySpendWindow;
	limitEnforce: ApiKeyLimitEnforcement;
}

/** No limit: the zero-effort default, and what an omitted POST field means. */
export const NO_SPEND_LIMIT: SpendLimitDraft = {
	limitUsd: "",
	limitWindow: DEFAULT_SPEND_WINDOW,
	limitEnforce: DEFAULT_LIMIT_ENFORCEMENT,
};

export const SPEND_WINDOW_OPTIONS: Array<{
	value: ApiKeySpendWindow;
	label: string;
}> = API_KEY_SPEND_WINDOWS.map((value) => ({
	value,
	label:
		value === "rolling_7d"
			? "Last 7 days (rolling)"
			: value === "rolling_30d"
				? "Last 30 days (rolling)"
				: "This calendar month",
}));

export const ENFORCEMENT_OPTIONS: Array<{
	value: ApiKeyLimitEnforcement;
	label: string;
}> = API_KEY_LIMIT_ENFORCEMENTS.map((value) => ({
	value,
	label: value === "block" ? "Block requests over the limit" : "Warn only",
}));

/** Short label for a window, for the gauge caption. */
export function spendWindowLabel(window: ApiKeySpendWindow | null): string {
	if (window === "rolling_7d") return "last 7 days";
	if (window === "calendar_month") return "this month";
	return "last 30 days";
}

/** Pull a key's stored limit into an editable draft. */
export function spendLimitDraftOf(key: {
	limitUsd?: number | null;
	limitWindow?: ApiKeySpendWindow | null;
	limitEnforce?: ApiKeyLimitEnforcement | null;
}): SpendLimitDraft {
	if (key.limitUsd == null) return NO_SPEND_LIMIT;
	return {
		limitUsd: String(key.limitUsd),
		limitWindow: key.limitWindow ?? DEFAULT_SPEND_WINDOW,
		limitEnforce: key.limitEnforce ?? DEFAULT_LIMIT_ENFORCEMENT,
	};
}

/**
 * Turn a draft into the PATCH/POST body, or report why it cannot be.
 *
 * The same rules as the server's hand-rolled validation, checked here only so
 * the operator gets the message before the round trip. The server is still the
 * authority — this never relaxes anything it enforces. An EMPTY box means
 * "no limit" and serialises to `limitUsd: null`, which is how a limit is
 * cleared; it is not an error.
 */
export function serializeSpendLimit(draft: SpendLimitDraft):
	| {
			ok: true;
			body: {
				limitUsd: number | null;
				limitWindow: ApiKeySpendWindow | null;
				limitEnforce: ApiKeyLimitEnforcement | null;
			};
	  }
	| { ok: false; error: string } {
	const text = draft.limitUsd.trim();
	if (text === "") {
		return {
			ok: true,
			body: { limitUsd: null, limitWindow: null, limitEnforce: null },
		};
	}
	const parsed = Number(text);
	if (!Number.isFinite(parsed)) {
		return { ok: false, error: "Spend limit must be a number." };
	}
	if (parsed <= 0) {
		return { ok: false, error: "Spend limit must be greater than 0." };
	}
	return {
		ok: true,
		body: {
			// A NUMBER, never the string: the endpoint rejects numeric strings
			// on purpose, so the parse has to happen on this side.
			limitUsd: parsed,
			limitWindow: draft.limitWindow,
			limitEnforce: draft.limitEnforce,
		},
	};
}

/**
 * Percentage of the limit spent, clamped to [0, 100] for the bar's width.
 *
 * Clamped for the BAR only — the numeric percentage the caption shows is
 * deliberately unclamped, because "112%" is the whole point of a warn-mode
 * limit and a bar pinned at 100% would hide it.
 */
export function spendPercent(spentUsd: number, limitUsd: number): number {
	if (!(limitUsd > 0)) return 0;
	return (spentUsd / limitUsd) * 100;
}

/**
 * Bar colour by severity.
 *
 * Identical thresholds and identical solid-variant classes as
 * overview/PoolUsageRow.tsx's `fillClass` (green under 60, amber under 80, red
 * at or above 80), so a bar in this tab means the same thing as a bar on the
 * overview. The solid variants matter: the pale .bg-success / .bg-warning are
 * badge tints and read as weaker than the track they sit on.
 */
export function spendFillClass(pct: number): string {
	if (pct < 60) return "bg-success-solid";
	if (pct < 80) return "bg-warning-solid";
	return "bg-destructive";
}

/** Text colour on the same thresholds, mirroring `headlineColor`. */
export function spendTextClass(pct: number): string {
	if (pct < 60) return "text-success";
	if (pct < 80) return "text-warning";
	return "text-destructive";
}

/** Does this key carry a limit at all? Keys without one show no gauge. */
export function hasSpendLimit(
	key: Pick<ApiKeyResponse, "limitUsd">,
): key is ApiKeyResponse & { limitUsd: number } {
	return typeof key.limitUsd === "number" && key.limitUsd > 0;
}
