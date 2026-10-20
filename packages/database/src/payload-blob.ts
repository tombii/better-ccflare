import {
	compressPayloadBytes,
	decompressPayloadBytes,
} from "./payload-compression";
import {
	decodePayloadFromStorage,
	decryptPayloadBytes,
	encryptPayloadBytes,
} from "./payload-encryption";

/**
 * Binary payload envelope stored in `request_payloads.payload`
 * (SQLite `BLOB`, PostgreSQL `BYTEA`).
 *
 * Layout: one flags byte followed by the body.
 *
 *   bit 0 (0x01) COMPRESSED — the body is a zstd frame of the UTF-8 JSON.
 *   bit 1 (0x02) ENCRYPTED  — the body is `iv(12) || ciphertext || authTag`;
 *                             the decrypted plaintext is the JSON, zstd-framed
 *                             when COMPRESSED is set as well.
 *
 * Why a binary envelope rather than the legacy `zst:`/`enc:` text strings:
 * both legacy formats base64 their body, which inflates every stored byte by
 * 33%. On a payload table that is the bulk of the database, that inflation is
 * pure waste — the compressed frame (or the ciphertext) is already the
 * smallest useful representation, and both engines can store raw bytes
 * natively. SQLite stores the frame in a BLOB, PostgreSQL in a BYTEA (where
 * TOAST compresses large values itself, and where an already-compressed frame
 * is stored as-is rather than being re-encoded through base64).
 *
 * The flags byte replaces the `zst:`/`enc:` prefixes, which is what made the
 * legacy format self-describing. The information content is identical:
 * COMPRESSED says "the body is a zstd frame", ENCRYPTED says "the body is
 * AES-256-GCM ciphertext".
 *
 * The legacy text format is still fully supported on read — rows written
 * before this change live in `request_payloads.json` and are decoded by
 * `decodePayloadFromStorage`. They age out through the normal payload
 * retention sweep, so no data migration is required.
 */

/** Body is a zstd frame of the UTF-8 JSON. */ export const PAYLOAD_FLAG_COMPRESSED = 0x01;
/** Body is `iv || ciphertext || authTag`; the plaintext is the JSON. */
export const PAYLOAD_FLAG_ENCRYPTED = 0x02;

/**
 * Encode a JSON payload into the binary envelope.
 *
 * Compression runs before encryption (ciphertext is incompressible), and
 * neither step is applied when it would not help: a payload that does not
 * shrink under zstd is stored verbatim, and with no `PAYLOAD_ENCRYPTION_KEY`
 * configured the body is left unencrypted.
 */
export async function encodePayloadBlob(json: string): Promise<Uint8Array> {
	const raw = new TextEncoder().encode(json);

	const { bytes: compressed, compressed: didCompress } =
		compressPayloadBytes(raw);
	let flags = didCompress ? PAYLOAD_FLAG_COMPRESSED : 0;

	const { bytes: body, encrypted } = await encryptPayloadBytes(compressed);
	if (encrypted) flags |= PAYLOAD_FLAG_ENCRYPTED;

	const envelope = new Uint8Array(1 + body.length);
	envelope[0] = flags;
	envelope.set(body, 1);
	return envelope;
}

/**
 * Decode a binary envelope back to its JSON string.
 *
 * Throws on:
 *  - a truncated envelope (no flags byte)
 *  - an encrypted body with no key configured
 *  - GCM authentication failure (wrong key OR tampering)
 *  - a corrupt zstd frame
 *
 * A failure is never swallowed here: silently returning junk would corrupt
 * downstream JSON.parse and hide tampering.
 */
export async function decodePayloadBlob(stored: Uint8Array): Promise<string> {
	if (stored.length < 1) {
		throw new Error("Stored payload envelope is empty");
	}

	const flags = stored[0];
	let body = stored.subarray(1);

	if (flags & PAYLOAD_FLAG_ENCRYPTED) {
		body = await decryptPayloadBytes(body);
	}
	if (flags & PAYLOAD_FLAG_COMPRESSED) {
		body = decompressPayloadBytes(body);
	}

	return new TextDecoder().decode(body);
}

/**
 * Normalise a value read back from a binary column into bytes.
 *
 * SQLite's `bun:sqlite` returns a BLOB as a `Uint8Array`, and Bun's
 * PostgreSQL driver returns a `bytea` as a `Buffer` (a `Uint8Array`
 * subclass) for prepared queries. A PostgreSQL query that is *not* prepared
 * receives the value in text format instead — `\\x` followed by hex — so that
 * case is decoded here rather than being handed to the envelope decoder as
 * garbage.
 *
 * Returns `null` for a SQL NULL.
 */
export function toStoredBytes(value: unknown): Uint8Array | null {
	if (value === null || value === undefined) return null;

	if (value instanceof Uint8Array) return value;

	if (typeof value === "string") {
		// PostgreSQL's text representation of a bytea.
		if (value.startsWith("\\x")) {
			const hex = value.slice(2);
			if (hex.length % 2 !== 0) {
				throw new Error("bytea hex payload has an odd length");
			}
			return new Uint8Array(Buffer.from(hex, "hex"));
		}
		return new TextEncoder().encode(value);
	}

	throw new Error(
		`Unexpected binary column value of type ${typeof value} (${value?.constructor?.name})`,
	);
}

/**
 * Decode a payload row, preferring the binary envelope and falling back to
 * the legacy text column.
 *
 * Rows written before the binary envelope existed have `payload IS NULL` and
 * carry the legacy `zst:`/`enc:` string in `json`. New rows always have a
 * `payload` and leave `json` empty.
 */
export async function decodeStoredPayload(
	payload: unknown,
	legacyJson: string | null | undefined,
): Promise<string> {
	const bytes = toStoredBytes(payload);
	if (bytes) return decodePayloadBlob(bytes);

	return decodePayloadFromStorage(legacyJson ?? "");
}
