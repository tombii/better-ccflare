/**
 * Responses request fields arrive as untrusted client JSON, so a value that is
 * not a string must never be interpolated, joined, compared as text, or
 * JSON-parsed. An object with `toString`/`valueOf` set to null is
 * JSON-serializable but throws on any string coercion, so reading a field's
 * shape is not enough — the coercion sites have to be guarded too.
 */
export function asText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
