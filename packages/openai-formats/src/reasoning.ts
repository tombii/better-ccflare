/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { ValidationError, getModelFamily } from "@better-ccflare/core";

export const REASONING_EFFORT_VALUES = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

const CLAUDE_REASONING_EFFORTS: Record<"opus" | "sonnet" | "haiku", readonly ReasoningEffort[]> = {
	opus: ["low", "medium", "high"],
	sonnet: ["low", "medium", "high"],
	haiku: ["low", "medium"],
};

const TARGET_REASONING_EFFORTS: Record<string, readonly ReasoningEffort[]> = {
	"gpt-5": ["low", "medium", "high"],
	"gpt-5.3-codex": ["low", "medium", "high"],
	"gpt-5.4-mini": ["low", "medium"],
};

function normalizeModelName(model: string): string {
	return model.toLowerCase().trim();
}

function normalizeTargetModelName(model: string): string {
	return normalizeModelName(model).replace(/^.*\//, "");
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

export function validateReasoningEffort(
	effort: unknown,
	models: { sourceModel?: string; targetModel?: string },
): ReasoningEffort | undefined {
	if (effort === undefined) {
		return undefined;
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

	const supportedModels = [models.sourceModel, models.targetModel].filter(
		(model): model is string => typeof model === "string" && model.length > 0,
	);

	for (const model of supportedModels) {
		const supportedEfforts = getSupportedReasoningEfforts(model);
		if (!supportedEfforts) {
			throw new ValidationError(
				`reasoning.effort is not supported for model ${model}`,
				"reasoning.effort",
				effort,
			);
		}

		if (!supportedEfforts.includes(effort as ReasoningEffort)) {
			throw new ValidationError(
				`reasoning.effort '${effort}' is not supported for model ${model}; allowed values: ${supportedEfforts.join(", ")}`,
				"reasoning.effort",
				effort,
			);
		}
	}

	return effort as ReasoningEffort;
}
