import type { RateLimitReason } from "@better-ccflare/types";

export type ErrorSeverity = "warning" | "error";

export interface ErrorMeta {
	title: string;
	description: string;
	suggestion: string;
	severity: ErrorSeverity;
}

const KNOWN_ERROR_META: Record<RateLimitReason, ErrorMeta> = {
	upstream_429_with_reset: {
		title: "Provider rate limit",
		description: "The upstream provider returned 429 with a known reset time.",
		suggestion: "The account will recover automatically at the reset time.",
		severity: "warning",
	},
	upstream_429_no_reset_probe_cooldown: {
		title: "Provider rate limit (no reset)",
		description:
			"The upstream provider returned 429 without a reset header; entering probe cooldown.",
		suggestion:
			"Cooldown defaults to 60s. Set `CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS` in your environment to change it.",
		severity: "warning",
	},
	upstream_429_no_reset_default_5h: {
		title: "Provider rate limit (legacy 5h ban)",
		description:
			"Legacy ban from ccflare ≤ v3.5.x. No longer emitted by current code.",
		suggestion: "Historical record — no action needed.",
		severity: "warning",
	},
	model_fallback_429: {
		title: "Rate limited — no fallback models",
		description:
			"The account was rate-limited and has no fallback models configured.",
		suggestion:
			"Configure model fallbacks for this account to enable automatic retry.",
		severity: "error",
	},
	all_models_exhausted_429: {
		title: "All fallback models rate-limited",
		description: "Every fallback model also returned 429.",
		suggestion: "Wait for cooldown, or add more diverse fallback models.",
		severity: "error",
	},
};

export function getErrorMeta(code: string): ErrorMeta {
	if (code in KNOWN_ERROR_META) {
		return KNOWN_ERROR_META[code as RateLimitReason];
	}
	return {
		title: code || "Unknown error",
		description: "No additional context is available for this error code.",
		suggestion: "Check the server logs or the original request for details.",
		severity: "error",
	};
}
