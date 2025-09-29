/**
 * Normalize tool/text content that may arrive with mojibake (UTF-8 seen as Latin-1),
 * and optionally strip a single pair of wrapping quotes.
 */
export function normalizeText(input: unknown): string {
	let s = typeof input === "string" ? input : "";
	if (!s) return "";

	// 1) If it's a JSON-encoded string (e.g., "...\n..."), try to parse directly
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		try {
			s = JSON.parse(s);
		} catch {
			// If JSON.parse fails, fall back to manual unquoting
			s = s.slice(1, -1);
		}
	} else if (/\\[nrt"\\]/.test(s)) {
		// 2) If it contains escaped sequences, decode them via JSON.parse wrapper
		try {
			const literal =
				'"' +
				s
					.replace(/\\/g, "\\\\")
					.replace(/\n/g, "\\n")
					.replace(/\r/g, "\\r")
					.replace(/\t/g, "\\t")
					.replace(/"/g, '\\"') +
				'"';
			s = JSON.parse(literal);
		} catch {
			// Ignore if decoding fails
		}
	}

	// 3) Heuristic: repair mojibake (UTF-8 mis-decoded as Latin-1)
	if (/[ÃÂâ]/.test(s)) {
		try {
			const bytes = new Uint8Array(
				Array.from(s, (ch) => ch.charCodeAt(0) & 0xff),
			);
			const recoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			if (recoded && recoded !== s) {
				s = recoded;
			}
		} catch {
			// Ignore decoding errors
		}
	}

	return s;
}
