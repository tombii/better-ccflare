import type { RateLimitReason } from "@better-ccflare/types";

export type ErrorSeverity = "warning" | "error";

export interface ErrorMeta {
	title: string;
	description: string;
	suggestion: string;
	severity: ErrorSeverity;
}

export interface ErrorContext {
	provider?: string | null;
	otherAccountsAvailable?: boolean;
}

const KNOWN_ERROR_META: Record<
	Exclude<RateLimitReason, "model_fallback_429">,
	ErrorMeta
> = {
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
	all_models_exhausted_429: {
		title: "All fallback models rate-limited",
		description: "Every fallback model also returned 429.",
		suggestion: "Wait for cooldown, or add more diverse fallback models.",
		severity: "error",
	},
};

function getModelFallbackMeta(context?: ErrorContext): ErrorMeta {
	const provider = context?.provider ?? null;
	const otherAccountsAvailable = context?.otherAccountsAvailable;

	const isOAuthOnlyProvider = provider === "anthropic" || provider === "codex";

	const suggestion = isOAuthOnlyProvider
		? "No action needed — Claude/Codex accounts only serve their native models, so the proxy will use the next account until this one recovers."
		: 'To retry on the same account before failing over, open this account\'s More actions → Model Mappings and add comma-separated alternates (e.g. "primary, fallback-1").';

	const baseDescription =
		"This account hit a 429 with only one model configured, so the proxy failed over to the next account in priority order.";

	if (otherAccountsAvailable === false) {
		return {
			title: "Account rate-limited — no in-account fallback",
			description: `No other accounts are available — requests will fail until this account recovers. ${baseDescription}`,
			suggestion,
			severity: "error",
		};
	}

	return {
		title: "Account rate-limited — no in-account fallback",
		description: baseDescription,
		suggestion,
		severity: "warning",
	};
}

export function getErrorMeta(code: string, context?: ErrorContext): ErrorMeta {
	if (code === "model_fallback_429") {
		return getModelFallbackMeta(context);
	}
	if (code in KNOWN_ERROR_META) {
		return KNOWN_ERROR_META[code as keyof typeof KNOWN_ERROR_META];
	}
	return {
		title: code || "Unknown error",
		description: "No additional context is available for this error code.",
		suggestion: "Check the server logs or the original request for details.",
		severity: "error",
	};
}
