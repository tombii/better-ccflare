import { Logger } from "@better-ccflare/logger";
import { resolveReasoningEffort } from "@better-ccflare/openai-formats";

const log = new Logger("ReasoningEffort");

/**
 * How an Anthropic-shaped upstream receives the client's reasoning effort.
 * - "output_config": Claude's native Messages API parameter
 *   `output_config.effort` (https://platform.claude.com/docs/en/build-with-claude/effort).
 *   The internal, non-standard `reasoning` key is always removed.
 * - "openrouter": OpenRouter's own `reasoning: { effort }` object, kept in
 *   place (only the effort value is clamped).
 */
export type AnthropicReasoningEffortStyle = "output_config" | "openrouter";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function clampEffort(effort: unknown, targetModel: unknown) {
	const resolution = resolveReasoningEffort(effort, {
		targetModel: typeof targetModel === "string" ? targetModel : undefined,
	});
	for (const downgrade of resolution.downgrades) {
		log.warn(
			`Downgraded reasoning effort for model ${downgrade.model}: ${downgrade.from} -> ${downgrade.to}`,
		);
	}
	return resolution.effort;
}

/**
 * Rewrite the internal `reasoning.effort` carrier on an Anthropic-shaped body
 * into the upstream's native field, in place. Never adds an effort the client
 * did not send, never overrides a client-supplied `output_config.effort`, and
 * clamps against `body.model` (call it after model mapping) via the shared
 * resolver. Throws ValidationError for an effort outside the known levels.
 *
 * @returns true when the body changed
 */
export function applyAnthropicReasoningEffort(
	body: Record<string, unknown>,
	style: AnthropicReasoningEffortStyle,
): boolean {
	if (!("reasoning" in body)) return false;
	const reasoning = body.reasoning;
	const effort = isPlainObject(reasoning) ? reasoning.effort : undefined;

	if (style === "openrouter") {
		if (!isPlainObject(reasoning) || effort === undefined) return false;
		const clamped = clampEffort(effort, body.model);
		if (clamped === effort) return false;
		body.reasoning = { ...reasoning, effort: clamped };
		return true;
	}

	delete body.reasoning;
	const outputConfig = body.output_config;
	const nativeEffort = isPlainObject(outputConfig)
		? outputConfig.effort
		: undefined;
	if (effort === undefined || nativeEffort !== undefined) return true;

	const clamped = clampEffort(effort, body.model);
	if (clamped !== undefined) {
		body.output_config = {
			...(isPlainObject(outputConfig) ? outputConfig : {}),
			effort: clamped,
		};
	}
	return true;
}
