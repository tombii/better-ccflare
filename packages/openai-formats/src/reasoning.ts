/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { getModelFamily, ValidationError } from "@better-ccflare/core";

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

const CLAUDE_REASONING_EFFORTS: Record<
	"opus" | "sonnet" | "haiku",
	readonly ReasoningEffort[]
> = {
	opus: ["low", "medium", "high", "xhigh", "max"],
	sonnet: ["low", "medium", "high", "xhigh", "max"],
	haiku: ["low", "medium"],
};

const TARGET_REASONING_EFFORTS: Record<string, readonly ReasoningEffort[]> = {
	"gpt-5": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.3-codex": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.4-mini": ["low", "medium"],
};

function normalizeTargetModelName(model: string): string {
	return model.toLowerCase().trim().replace(/^.*\//, "");
}

export function getSupportedReasoningEfforts(
	model: string,
): readonly ReasoningEffort[] | null {
	const normalized = normalizeTargetModelName(model);
	const family = getModelFamily(normalized);
	if (family) {
		return CLAUDE_REASONING_EFFORTS[family];
	}

	if (normalized in TARGET_REASONING_EFFORTS) {
		return TARGET_REASONING_EFFORTS[normalized];
	}

	if (normalized.startsWith("gpt-5")) {
		return TARGET_REASONING_EFFORTS["gpt-5"];
	}

	return null;
}

export interface ReasoningEffortResolution {
	effort: ReasoningEffort | undefined;
	downgrades: Array<{
		model: string;
		from: ReasoningEffort;
		to: ReasoningEffort;
	}>;
}

export function resolveReasoningEffort(
	effort: unknown,
	models: { sourceModel?: string; targetModel?: string },
): ReasoningEffortResolution {
	if (effort === undefined) {
		return { effort: undefined, downgrades: [] };
	}

	if (
		typeof effort !== "string" ||
		!REASONING_EFFORT_VALUES.includes(effort as ReasoningEffort)
	) {
		throw new ValidationError(
			`reasoning.effort must be one of: ${REASONING_EFFORT_VALUES.join(", ")}`,
			"reasoning.effort",
			effort,
		);
	}

	let resolvedEffort = effort as ReasoningEffort;
	const downgrades: Array<{
		model: string;
		from: ReasoningEffort;
		to: ReasoningEffort;
	}> = [];

	const supportedModels = [models.sourceModel, models.targetModel].filter(
		(model): model is string => typeof model === "string" && model.length > 0,
	);

	for (const model of supportedModels) {
		const supportedEfforts = getSupportedReasoningEfforts(model);
		if (!supportedEfforts) {
			throw new ValidationError(
				`reasoning.effort is not supported for model ${model}`,
				"reasoning.effort",
				resolvedEffort,
			);
		}

		if (supportedEfforts.includes(resolvedEffort)) {
			continue;
		}

		const requestedRank = EFFORT_RANK[resolvedEffort];
		const nearestLower = [...supportedEfforts]
			.filter((candidate) => EFFORT_RANK[candidate] <= requestedRank)
			.sort((a, b) => EFFORT_RANK[b] - EFFORT_RANK[a])[0];

		if (!nearestLower) {
			throw new ValidationError(
				`reasoning.effort '${resolvedEffort}' is not supported for model ${model}; allowed values: ${supportedEfforts.join(", ")}`,
				"reasoning.effort",
				resolvedEffort,
			);
		}

		downgrades.push({
			model,
			from: resolvedEffort,
			to: nearestLower,
		});
		resolvedEffort = nearestLower;
	}

	return { effort: resolvedEffort, downgrades };
}

export function validateReasoningEffort(
	effort: unknown,
	models: { sourceModel?: string; targetModel?: string },
): ReasoningEffort | undefined {
	return resolveReasoningEffort(effort, models).effort;
}
