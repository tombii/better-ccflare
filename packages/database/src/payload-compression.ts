import { Logger } from "@better-ccflare/logger";

/**
 * Payload compression at rest using zstd.
 *
 * Stored format: `zst:` + base64(zstd(bytes)).
 *
 * Why application-level and not SQLite/Postgres: neither engine offers
 * transparent table compression that we can rely on. SQLite has no built-in
 * page compression (ZIPVFS write-compression is commercially licensed), and
 * Postgres TOAST only kicks in above its own threshold. Doing it here means the
 * exact same bytes land in either backend, `json` stays a TEXT column, and no
 * migration is required.
 *
 * This layer is deliberately independent of encryption:
 *  - `compressPayload`/`decompressPayload` are pure and never touch a key, so
 *    compression works with or without PAYLOAD_ENCRYPTION_KEY set.
 *  - The storage codec in `payload-encryption.ts` composes the two in the
 *    correct order (compress, THEN encrypt — ciphertext is incompressible).
 *
 * Legacy rows (plaintext JSON, or ciphertext whose body is raw JSON) are
 * untouched by `decompressPayload`, so existing databases stay readable with no
 * migration.
 */

const log = new Logger("PayloadCompression");

export const COMPRESSED_PREFIX = "zst:";

/**
 * Payloads smaller than this are stored verbatim. Below a few hundred bytes the
 * zstd frame header (~13 bytes) plus base64's 33% expansion can make the stored
 * value LARGER than the input, and the CPU cost buys nothing.
 */
const MIN_COMPRESS_BYTES = 512;

/**
 * Compress a UTF-8 payload string for storage.
 *
 * Returns `zst:`-prefixed base64 when compression actually shrinks the value,
 * otherwise returns the input unchanged. The "did it help?" check keeps the
 * invariant that this function never inflates a payload — small or
 * incompressible inputs fall through untouched, and the caller does not need to
 * decide.
 */
export function compressPayload(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length < MIN_COMPRESS_BYTES) return text;

	const encoded =
		COMPRESSED_PREFIX +
		Buffer.from(Bun.zstdCompressSync(bytes)).toString("base64");

	// Compare against the original byte length (not string length): the stored
	// value is what we're trying to shrink, and base64 length is in bytes.
	return encoded.length < bytes.length ? encoded : text;
}

/**
 * Compress raw bytes for the binary (BLOB) storage path.
 *
 * Unlike `compressPayload`, the "did it help?" check compares the compressed
 * byte count against the raw byte count. The text path has to compare against
 * the *base64* length because that is what it stores; the binary path stores
 * the compressed frame as-is, so a smaller frame is a smaller row.
 *
 * Returns the bytes to store plus whether compression was actually applied —
 * the caller needs that flag to build the envelope's flags byte.
 */
export function compressPayloadBytes(bytes: Uint8Array): {
	bytes: Uint8Array;
	compressed: boolean;
} {
	if (bytes.length < MIN_COMPRESS_BYTES) return { bytes, compressed: false };

	const compressed = Bun.zstdCompressSync(bytes);
	return compressed.length < bytes.length
		? { bytes: compressed, compressed: true }
		: { bytes, compressed: false };
}

/**
 * Decompress a zstd frame produced by `compressPayloadBytes`.
 *
 * Throws if the frame is corrupt — silently returning junk would break
 * downstream JSON.parse.
 */
export function decompressPayloadBytes(bytes: Uint8Array): Uint8Array {
	return Bun.zstdDecompressSync(bytes);
}

/**
 * Reverse `compressPayload`. Values without the `zst:` prefix pass through
 * unchanged, which covers every legacy row and any payload small enough that
 * compression was skipped.
 *
 * Throws if a `zst:`-marked value fails to decompress — that indicates
 * corruption, and silently returning junk would break downstream JSON.parse.
 */
export function decompressPayload(stored: string): string {
	if (!stored.startsWith(COMPRESSED_PREFIX)) return stored;

	const compressed = Buffer.from(
		stored.slice(COMPRESSED_PREFIX.length),
		"base64",
	);
	try {
		return Buffer.from(Bun.zstdDecompressSync(compressed)).toString("utf8");
	} catch (err) {
		log.error("Failed to decompress zstd payload:", err);
		throw err;
	}
}

/** Returns true when the value carries the compression marker. */
export function isCompressed(stored: string): boolean {
	return stored.startsWith(COMPRESSED_PREFIX);
}
