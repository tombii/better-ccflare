/**
 * Payload compression at rest using gzip (Bun built-ins).
 *
 * Stored form before encryption: base64(gzip(utf8 plaintext)).
 * Legacy rows keep `compressed = 0` and store plaintext JSON (optionally encrypted).
 */

/** gzip → base64 for storage in TEXT columns prior to optional encryption. */
export function compressPayload(plaintext: string): string {
	const gzipped = Bun.gzipSync(Buffer.from(plaintext, "utf8"));
	return Buffer.from(gzipped).toString("base64");
}

/** Reverse {@link compressPayload}. */
export function decompressPayload(compressedBase64: string): string {
	const bytes = Buffer.from(compressedBase64, "base64");
	const decompressed = Bun.gunzipSync(bytes);
	return Buffer.from(decompressed).toString("utf8");
}
