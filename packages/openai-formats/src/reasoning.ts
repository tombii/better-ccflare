/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { getModelFamily, ValidationError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("openai-formats/reasoning");

export const REASONING_EFFORT_VALUES = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

const EFFORT_RANK: Record<ReasoningEffort, number> = {
	minimal: 0,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	max: 5,
};

type ClaudeFamily = "fable" | "opus" | "sonnet" | "haiku";

/** Every level supported by the current (5.x and Opus 4.7+) generation. */
const CLAUDE_ALL_EFFORTS: readonly ReasoningEffort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Opus/Sonnet 4.6 predate `xhigh`. */
const CLAUDE_NO_XHIGH_EFFORTS: readonly ReasoningEffort[] = [
	"low",
	"medium",
	"high",
	"max",
];

/** Opus 4.5 predates `xhigh` and `max`. */
const CLAUDE_LOW_TO_HIGH_EFFORTS: readonly ReasoningEffort[] = [
	"low",
	"medium",
	"high",
];

/**
 * Built-in target table for non-Claude models, keyed by the shortest model-id
 * prefix that covers every spelling of a model (dated snapshots and vendor
 * variants append a `-`/`.` suffix). Matching is longest-prefix, so a more
 * specific row always wins over its parent (`gpt-5.4-mini` over `gpt-5`).
 *
 * `mistral-small-2603` and `mistral-medium-3-5` are deliberately absent: the
 * Mistral docs mention only `none` and `high` for them without enumerating
 * the accepted set, so any level list would be a guess. Operators can add
 * them through the capability map.
 */
const TARGET_REASONING_EFFORTS: Record<string, readonly ReasoningEffort[]> = {
	"gpt-5": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.4-mini": ["low", "medium"],
	// Mistral docs: low/medium/high; none, minimal, xhigh and max are rejected.
	"mistral-large-4": ["low", "medium", "high"],
	// Mistral docs: only low, high and max.
	"zai-glm-5-3": ["low", "high", "max"],
};

// Anthropic uses two model-id orders:
//   new style: claude-<family>-<major>[-<minor>]…  (claude-opus-4-7)
//   old style: claude-<major>[-<minor>]-<family>…  (claude-3-5-sonnet-20241022)
// A version component is at most two digits, so an eight-digit date snapshot
// such as claude-sonnet-4-20250514 is read as Sonnet 4.0, not 4.20250514.
const CLAUDE_FAMILY_FIRST =
	/claude[-._ ]+(fable|opus|sonnet|haiku)[-._ ]+(\d{1,2})(?:[-._ ](\d{1,2})(?!\d))?/;
const CLAUDE_VERSION_FIRST =
	/claude[-._ ]+(\d{1,2})(?:[-._ ](\d{1,2})(?!\d))?[-._ ]+(fable|opus|sonnet|haiku)/;

interface ClaudeModelVersion {
	family: ClaudeFamily;
	major: number;
	minor: number;
}

function parseClaudeModelVersion(model: string): ClaudeModelVersion | null {
	const familyFirst = CLAUDE_FAMILY_FIRST.exec(model);
	if (familyFirst) {
		return {
			family: familyFirst[1] as ClaudeFamily,
			major: Number.parseInt(familyFirst[2], 10),
			minor: familyFirst[3] ? Number.parseInt(familyFirst[3], 10) : 0,
		};
	}
	const versionFirst = CLAUDE_VERSION_FIRST.exec(model);
	if (versionFirst) {
		return {
			family: versionFirst[3] as ClaudeFamily,
			major: Number.parseInt(versionFirst[1], 10),
			minor: versionFirst[2] ? Number.parseInt(versionFirst[2], 10) : 0,
		};
	}
	return null;
}

function claudeEffortsForVersion(
	family: ClaudeFamily,
	major: number,
	minor: number,
): readonly ReasoningEffort[] {
	if (major >= 5) return CLAUDE_ALL_EFFORTS;

	switch (family) {
		case "fable":
			// Fable ships at 5.x only; an unexpected older id keeps full support
			// rather than silently dropping the parameter.
			return CLAUDE_ALL_EFFORTS;
		case "opus":
			if (major === 4 && minor >= 7) return CLAUDE_ALL_EFFORTS;
			if (major === 4 && minor === 6) return CLAUDE_NO_XHIGH_EFFORTS;
			if (major === 4 && minor === 5) return CLAUDE_LOW_TO_HIGH_EFFORTS;
			return [];
		case "sonnet":
			if (major === 4 && minor === 6) return CLAUDE_NO_XHIGH_EFFORTS;
			return [];
		case "haiku":
			return [];
	}
}

/**
 * Effort support depends on the Claude generation, not just the family.
 * Claude Opus 4.6 and Sonnet 4.6 predate `xhigh`; Opus 4.5 predates `max`;
 * Haiku 4.5 and Sonnet 4.5 and older reject the effort parameter with a 400,
 * so an empty list means "no level may be sent" and the field is dropped.
 *
 * A bare alias (bare `sonnet`, `opus`, `haiku`, `claude-haiku`) conventionally
 * points at the current generation, so an unparseable id keeps full support
 * instead of silently losing the parameter. The operator capability map can
 * still narrow any of these rows.
 */
function getClaudeReasoningEfforts(model: string): readonly ReasoningEffort[] {
	const version = parseClaudeModelVersion(model);
	if (!version) return CLAUDE_ALL_EFFORTS;
	return claudeEffortsForVersion(version.family, version.major, version.minor);
}

/**
 * Longest-prefix lookup in the target table. A key matches the whole model
 * name, or the model name followed by `-` or `.`; both separators occur
 * (`gpt-5.4-mini` follows `gpt-5` with `.`, `gpt-5.4-mini-2026-01-01` follows
 * `gpt-5.4-mini` with `-`). Requires a boundary so `gpt-50` does not inherit
 * the `gpt-5` row.
 */
function findTargetReasoningEfforts(
	model: string,
): readonly ReasoningEffort[] | null {
	let bestKey = "";
	for (const key of Object.keys(TARGET_REASONING_EFFORTS)) {
		if (key.length <= bestKey.length) continue;
		if (
			model === key ||
			model.startsWith(`${key}-`) ||
			model.startsWith(`${key}.`)
		) {
			bestKey = key;
		}
	}
	return bestKey ? TARGET_REASONING_EFFORTS[bestKey] : null;
}

function normalizeTargetModelName(model: string): string {
	return model.toLowerCase().trim().replace(/^.*\//, "");
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return (
		typeof value === "string" &&
		REASONING_EFFORT_VALUES.includes(value as ReasoningEffort)
	);
}

/**
 * Operator-supplied capability map (model -> supported levels), keyed by the
 * normalized model name. It only narrows what a request may carry (clamping);
 * it never makes the router add an effort the client did not send.
 *
 * openai-formats must not depend on @better-ccflare/config, so the server
 * injects the map with setReasoningEffortOverrides() at startup and again
 * whenever the `reasoning_efforts` config key changes. Sources, in order:
 * the CCFLARE_REASONING_EFFORTS env var (JSON), the config-file field
 * `reasoning_efforts`, then nothing (built-in tables only).
 */
let reasoningEffortOverrides: Record<string, readonly ReasoningEffort[]> = {};

/**
 * Replace the operator override map. Keys are normalized like target model
 * names (case, surrounding whitespace and any provider prefix up to the last
 * "/" are ignored). Unknown levels are dropped with a warning, duplicates are
 * removed, levels are ordered by rank, and entries left empty are ignored.
 * Pass null/undefined to clear.
 */
export function setReasoningEffortOverrides(
	overrides: Readonly<Record<string, readonly string[]>> | null | undefined,
): void {
	const next: Record<string, readonly ReasoningEffort[]> = {};
	if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
		for (const [model, levels] of Object.entries(overrides)) {
			if (!Array.isArray(levels)) continue;
			const key = normalizeTargetModelName(model);
			if (!key) continue;
			const valid = new Set<ReasoningEffort>();
			for (const level of levels) {
				if (isReasoningEffort(level)) {
					valid.add(level);
				} else {
					log.warn(
						`Ignoring unknown reasoning effort ${JSON.stringify(level)} in override for model ${model}`,
					);
				}
			}
			if (valid.size === 0) continue;
			next[key] = [...valid].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
		}
	}
	reasoningEffortOverrides = next;
}

/** The active operator override map (normalized keys). */
export function getReasoningEffortOverrides(): Readonly<
	Record<string, readonly ReasoningEffort[]>
> {
	return { ...reasoningEffortOverrides };
}

export function getSupportedReasoningEfforts(
	model: string,
): readonly ReasoningEffort[] | null {
	const normalized = normalizeTargetModelName(model);
	if (Object.hasOwn(reasoningEffortOverrides, normalized)) {
		return reasoningEffortOverrides[normalized];
	}
	const family = getModelFamily(normalized);
	if (family) {
		return getClaudeReasoningEfforts(normalized);
	}

	return findTargetReasoningEfforts(normalized);
}

export interface ReasoningEffortResolution {
	effort: ReasoningEffort | undefined;
	downgrades: Array<{
		model: string;
		from: ReasoningEffort;
		to: ReasoningEffort;
	}>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The reasoning effort a client sent on an Anthropic-shaped request body.
 *
 * The internal `reasoning.effort` carrier wins. Otherwise Claude's native
 * Messages API field `output_config.effort` is used: it is what Claude Code
 * and the Anthropic SDKs send, and without this fallback it would be lost
 * whenever the request is converted for a non-Anthropic upstream (Chat
 * Completions, OpenRouter, Codex). Null counts as absent, as in the
 * pre-flight validation.
 *
 * Returns the raw value, unvalidated; pass it through
 * `resolveReasoningEffort` to validate and clamp it.
 */
export function readClientReasoningEffort(body: unknown): unknown {
	if (!isPlainRecord(body)) return undefined;
	const reasoning = body.reasoning;
	if (isPlainRecord(reasoning) && reasoning.effort != null) {
		return reasoning.effort;
	}
	const outputConfig = body.output_config;
	if (isPlainRecord(outputConfig) && outputConfig.effort != null) {
		return outputConfig.effort;
	}
	return undefined;
}

// sourceModel is accepted for API symmetry but only targetModel is used for
// downgrade resolution — the source model's effort ceiling must not further
// constrain the value sent to a capable target.
export function resolveReasoningEffort(
	effort: unknown,
	models: { sourceModel?: string; targetModel?: string },
): ReasoningEffortResolution {
	if (effort === undefined) {
		return { effort: undefined, downgrades: [] };
	}

	if (!isReasoningEffort(effort)) {
		throw new ValidationError(
			`reasoning.effort must be one of: ${REASONING_EFFORT_VALUES.join(", ")}`,
			"reasoning.effort",
			effort,
		);
	}

	let resolvedEffort: ReasoningEffort | undefined = effort;
	const downgrades: Array<{
		model: string;
		from: ReasoningEffort;
		to: ReasoningEffort;
	}> = [];

	const modelContexts = [{ model: models.targetModel }].filter(
		(context): context is { model: string } =>
			typeof context.model === "string" && context.model.length > 0,
	);

	for (const { model } of modelContexts) {
		if (resolvedEffort === undefined) break;
		const supportedEfforts = getSupportedReasoningEfforts(model);
		if (!supportedEfforts) {
			// Unknown model (source or target) — pass through unchanged
			continue;
		}

		if (supportedEfforts.length === 0) {
			// The model rejects the effort parameter outright (e.g. Claude
			// Haiku 4.5 and older): sending any level would 400, so drop the
			// field. That is not a downgrade, so it is not recorded as one.
			resolvedEffort = undefined;
			continue;
		}

		if (supportedEfforts.includes(resolvedEffort)) {
			continue;
		}

		// Find nearest supported effort (prefer nearest lower; fall back to minimum)
		const currentRank = EFFORT_RANK[resolvedEffort];
		let nearest: ReasoningEffort | undefined;
		for (const supported of supportedEfforts) {
			const rank = EFFORT_RANK[supported];
			if (rank <= currentRank) {
				if (nearest === undefined || rank > EFFORT_RANK[nearest]) {
					nearest = supported;
				}
			}
		}

		if (nearest === undefined) {
			// Requested effort is below model minimum — clamp up to minimum
			nearest = supportedEfforts[0];
		}

		// Only record as a downgrade when rank actually decreases
		if (EFFORT_RANK[nearest] < currentRank) {
			downgrades.push({
				model,
				from: resolvedEffort,
				to: nearest,
			});
		}
		resolvedEffort = nearest;
	}

	return { effort: resolvedEffort, downgrades };
}

export function validateReasoningEffort(
	effort: unknown,
	models: { sourceModel?: string; targetModel?: string },
): ReasoningEffort | undefined {
	return resolveReasoningEffort(effort, models).effort;
}
