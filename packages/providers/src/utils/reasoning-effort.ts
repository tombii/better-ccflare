import { ValidationError } from "@better-ccflare/core";
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
 * clamps via the shared resolver against `targetModel`: the model the
 * upstream actually runs. It defaults to `body.model` (call it after model
 * mapping); a provider that sends the model outside the body (Vertex AI puts
 * it in the URL) passes it explicitly. Throws ValidationError for an effort
 * outside the known levels.
 *
 * @returns true when the body changed
 */
export function applyAnthropicReasoningEffort(
	body: Record<string, unknown>,
	style: AnthropicReasoningEffortStyle,
	targetModel: unknown = body.model,
): boolean {
	if (!("reasoning" in body)) return false;
	const reasoning = body.reasoning;
	const effort = isPlainObject(reasoning) ? reasoning.effort : undefined;

	if (style === "openrouter") {
		if (!isPlainObject(reasoning) || effort === undefined) return false;
		const clamped = clampEffort(effort, targetModel);
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

	const clamped = clampEffort(effort, targetModel);
	if (clamped !== undefined) {
		body.output_config = {
			...(isPlainObject(outputConfig) ? outputConfig : {}),
			effort: clamped,
		};
	}
	return true;
}

/**
 * Validate a client-supplied `reasoning.effort` before any account is tried.
 *
 * `resolveReasoningEffort` throws `ValidationError` for a value outside the
 * known levels; letting that happen inside the per-account attempt turns a
 * client error into an "all accounts failed" 503 after every account has been
 * retried. Callers use this to answer 400 up front instead.
 *
 * @returns null when the value is absent or valid, otherwise the validation
 * message
 */
export function getReasoningEffortError(effort: unknown): string | null {
	if (effort === undefined || effort === null) return null;
	try {
		resolveReasoningEffort(effort, {});
		return null;
	} catch (error) {
		if (error instanceof ValidationError) return error.message;
		throw error;
	}
}

export interface ReclampReasoningEffortOptions {
	/**
	 * Leave `output_config.effort` alone even when `requestedEffort` is
	 * given. Set it when the client sent `output_config.effort` natively: the
	 * Anthropic-shaped transform keeps that value verbatim (it never clamps or
	 * overrides it), so re-resolving it from `reasoning.effort` would replace
	 * the client's choice.
	 */
	preserveOutputConfigEffort?: boolean;
}

/**
 * Re-resolve the effort already on an OUTBOUND (provider-transformed) body
 * against `model`, in place. For callers that change the model after the
 * provider transform ran (the proxy's model-fallback loop forces the fallback
 * model back into the body, while the transform clamped against whatever
 * model mapping produced).
 *
 * Exactly one native field is rewritten, the first present of
 * `output_config.effort` (Anthropic-shaped), `reasoning_effort` (Chat
 * Completions) or `reasoning.effort` (OpenRouter). An effort is never added
 * where none is present.
 *
 * `requestedEffort` is the client's original value (the internal
 * `reasoning.effort` before the transform). When given, resolution starts from
 * it, so the transform's clamp and this one never compound. Without it the
 * current value is re-clamped.
 *
 * Limitation: an outbound `output_config.effort` looks the same whether the
 * transform produced it or the client sent it natively. Without
 * `requestedEffort` it is therefore left untouched (it may be the client's);
 * with `requestedEffort` it is rewritten unless
 * `options.preserveOutputConfigEffort` says the client sent it natively.
 *
 * Throws ValidationError for an effort outside the known levels.
 *
 * @returns true when the body changed
 */
export function reclampReasoningEffort(
	body: Record<string, unknown>,
	model: string,
	requestedEffort?: unknown,
	options: ReclampReasoningEffortOptions = {},
): boolean {
	const outputConfig = body.output_config;
	if (isPlainObject(outputConfig) && outputConfig.effort !== undefined) {
		if (requestedEffort === undefined || options.preserveOutputConfigEffort) {
			return false;
		}
		const clamped = clampEffort(requestedEffort, model);
		if (clamped === undefined || clamped === outputConfig.effort) return false;
		body.output_config = { ...outputConfig, effort: clamped };
		return true;
	}

	if (body.reasoning_effort !== undefined) {
		const clamped = clampEffort(
			requestedEffort ?? body.reasoning_effort,
			model,
		);
		if (clamped === undefined || clamped === body.reasoning_effort)
			return false;
		body.reasoning_effort = clamped;
		return true;
	}

	const reasoning = body.reasoning;
	if (isPlainObject(reasoning) && reasoning.effort !== undefined) {
		const clamped = clampEffort(requestedEffort ?? reasoning.effort, model);
		if (clamped === undefined || clamped === reasoning.effort) return false;
		body.reasoning = { ...reasoning, effort: clamped };
		return true;
	}

	return false;
}
