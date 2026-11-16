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

/**
 * The native outbound field a provider uses for the client's reasoning effort.
 * `output_config` is Claude's Messages API (`output_config.effort`), `reasoning`
 * is OpenRouter's `reasoning: { effort }` object, `reasoning_effort` is the
 * Chat Completions top-level key.
 */
export type ReasoningEffortTarget =
	| "output_config"
	| "reasoning"
	| "reasoning_effort";

/**
 * Put a client's reasoning effort back on an OUTBOUND body after a model
 * fallback, in the provider's native shape. The provider transform clamps
 * against the model the ACCOUNT MAPPING produced, which may reject the
 * parameter outright (e.g. a Haiku 4.5 mapping), so the field never reaches the
 * transformed body; `reclampReasoningEffort` can only rewrite an existing
 * field, never add one. This is the add half.
 *
 * Resolves `requestedEffort` against `model` — the model actually sent — with
 * the same `clampEffort` the neighbouring helpers use. It never overwrites a
 * field the body already carries (that value is the transform's or the
 * reclamp's business and may be client-native), and never adds one for a model
 * that still rejects the parameter, for a missing effort or for an invalid one.
 *
 * @returns true when the body changed
 */
export function restoreReasoningEffort(
	body: Record<string, unknown>,
	target: ReasoningEffortTarget,
	requestedEffort: unknown,
	model: string,
): boolean {
	let clamped: ReturnType<typeof clampEffort>;
	try {
		clamped = clampEffort(requestedEffort, model);
	} catch (error) {
		// An invalid level is a client error the pre-flight validation already
		// answered; there is nothing to restore here.
		if (error instanceof ValidationError) return false;
		throw error;
	}
	if (clamped === undefined) return false;

	if (target === "output_config") {
		const outputConfig = body.output_config;
		if (isPlainObject(outputConfig) && outputConfig.effort !== undefined) {
			return false;
		}
		body.output_config = {
			...(isPlainObject(outputConfig) ? outputConfig : {}),
			effort: clamped,
		};
		return true;
	}

	if (target === "reasoning_effort") {
		if (body.reasoning_effort !== undefined) return false;
		body.reasoning_effort = clamped;
		return true;
	}

	const reasoning = body.reasoning;
	if (isPlainObject(reasoning) && reasoning.effort !== undefined) return false;
	body.reasoning = {
		...(isPlainObject(reasoning) ? reasoning : {}),
		effort: clamped,
	};
	return true;
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
 * where none is present; it is removed when the model rejects the parameter
 * outright (resolution returns undefined, e.g. Claude Haiku 4.5).
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
		if (clamped === outputConfig.effort) return false;
		if (clamped === undefined) {
			// The model rejects the parameter outright (e.g. Claude Haiku 4.5):
			// a stale effort would 400, so remove it and keep the other keys.
			const { effort: _dropped, ...rest } = outputConfig;
			body.output_config = rest;
			return true;
		}
		body.output_config = { ...outputConfig, effort: clamped };
		return true;
	}

	if (body.reasoning_effort !== undefined) {
		const clamped = clampEffort(
			requestedEffort ?? body.reasoning_effort,
			model,
		);
		if (clamped === body.reasoning_effort) return false;
		if (clamped === undefined) {
			delete body.reasoning_effort;
			return true;
		}
		body.reasoning_effort = clamped;
		return true;
	}

	const reasoning = body.reasoning;
	if (isPlainObject(reasoning) && reasoning.effort !== undefined) {
		const clamped = clampEffort(requestedEffort ?? reasoning.effort, model);
		if (clamped === reasoning.effort) return false;
		if (clamped === undefined) {
			const { effort: _dropped, ...rest } = reasoning;
			body.reasoning = rest;
			return true;
		}
		body.reasoning = { ...reasoning, effort: clamped };
		return true;
	}

	return false;
}
