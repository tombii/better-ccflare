// Normalization of OpenAI `content` fields that some gateways shape as an
// array of content blocks rather than a plain string.
//
// Mistral serving zai-glm-5-3-flash streams `delta.content` as
// `[{type:"thinking", thinking:[{type:"text", text:"..."}], closed:true}, ...]`
// one fragment per chunk for the reasoning phase, then a final mixed chunk
// carrying a thinking block and a `{type:"text"}` block. Non-streaming, the
// same model returns that array on `choices[0].message.content`. Plain models
// still send a string, which must behave exactly as before.

export interface NormalizedOpenAIContent {
	/** Concatenated thinking-block text (empty when no thinking blocks). */
	thinking: string;
	/** Concatenated text-block text (the string itself for string content). */
	text: string;
	/** True when there is text to emit (string content that is non-empty, or
	 *  text blocks that join to a non-empty string). */
	hasContent: boolean;
}

/** Join an array of `{type:"text", text}` parts; non-text parts are ignored. */
function joinTextParts(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	let out = "";
	for (const part of parts) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text"
		) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") out += text;
		}
	}
	return out;
}

/**
 * Normalize an OpenAI `content` value (string, block array, or null) into
 * thinking text and text. Unknown block types and the `closed` flag are
 * ignored — `closed: true` does not mean the upstream thinking block ended.
 */
export function normalizeOpenAIContent(
	content: unknown,
): NormalizedOpenAIContent {
	// `hasContent` is `Boolean(content)` for strings/absent values, matching the
	// historical `if (delta?.content)` truthiness check byte for byte.
	if (typeof content === "string") {
		return { thinking: "", text: content, hasContent: Boolean(content) };
	}
	if (!Array.isArray(content)) {
		return { thinking: "", text: "", hasContent: false };
	}

	let thinking = "";
	let text = "";
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const { type } = block as { type?: unknown };
		if (type === "text") {
			const value = (block as { text?: unknown }).text;
			if (typeof value === "string") text += value;
		} else if (type === "thinking") {
			const value = (block as { thinking?: unknown }).thinking;
			if (typeof value === "string") {
				thinking += value;
			} else {
				thinking += joinTextParts(value);
			}
		}
	}
	return { thinking, text, hasContent: Boolean(text) };
}
