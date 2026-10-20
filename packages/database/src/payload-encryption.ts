import { Logger } from "@better-ccflare/logger";
import { compressPayload, decompressPayload } from "./payload-compression";

/**
 * Payload storage codec: compression (see `payload-compression.ts`) composed
 * with optional AES-256-GCM encryption (Web Crypto).
 *
 * Stored format: `enc:` + base64(iv || ciphertext || authTag) over an inner
 * body that is either raw JSON or `zst:` + base64(zstd(json)).
 *
 * - The 12-byte IV is generated per-encryption with `crypto.getRandomValues`.
 * - GCM's authentication tag is appended by `crypto.subtle.encrypt`, so any
 *   tampering or wrong-key decryption fails loudly (the tag check throws).
 * - When `PAYLOAD_ENCRYPTION_KEY` is unset, encrypt is a pass-through and
 *   decrypt accepts plaintext as-is — this keeps existing databases readable
 *   and lets operators opt in without a migration. Compression still applies,
 *   with or without a key.
 * - Compression runs BEFORE encryption (ciphertext is incompressible), and
 *   decryption runs before decompression on read.
 *
 * Bun Workers have isolated module scopes, so any worker that calls these
 * helpers MUST also call `initPayloadEncryption()` at module load time.
 */

const log = new Logger("PayloadEncryption");

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const KEY_LENGTH_BITS = 256;
const KEY_LENGTH_BYTES = 32;
const HEX_KEY_LENGTH = KEY_LENGTH_BYTES * 2;
const ENC_PREFIX = "enc:";

let encryptionKey: CryptoKey | null = null;
let initPromise: Promise<boolean> | null = null;
/** The `PAYLOAD_ENCRYPTION_KEY` value the current `initPromise` was built from. */
let initializedKeyHex: string | null = null;

/**
 * Initialize the payload encryption key from `PAYLOAD_ENCRYPTION_KEY`
 * (a 64-character hex string = 32 bytes = AES-256).
 *
 * Idempotent — concurrent or repeated calls share the same in-flight promise.
 * Returns `true` when encryption is enabled, `false` when no key is configured
 * or initialization failed (the function never throws).
 *
 * The cached promise is keyed on the configured key: if
 * `PAYLOAD_ENCRYPTION_KEY` changes, the key is re-imported rather than the
 * stale one being kept forever. In production the variable is fixed for the
 * process lifetime, so this only matters when the key is set *after* the
 * first call (tests, or a key that is injected late).
 */
export function initPayloadEncryption(): Promise<boolean> {
	const keyHex = process.env.PAYLOAD_ENCRYPTION_KEY ?? null;
	if (initPromise && keyHex === initializedKeyHex) return initPromise;
	initializedKeyHex = keyHex;
	initPromise = doInit();
	return initPromise;
}

async function doInit(): Promise<boolean> {
	// Drop any previously imported key first: `initPayloadEncryption` re-runs
	// this when the configured key changes, and a stale key must never be used
	// to encrypt (or fail to decrypt) with the new configuration.
	encryptionKey = null;

	const keyHex = process.env.PAYLOAD_ENCRYPTION_KEY;
	if (!keyHex) {
		log.info("PAYLOAD_ENCRYPTION_KEY not set — payloads stored in plaintext");
		return false;
	}

	if (keyHex.length !== HEX_KEY_LENGTH) {
		log.error(
			`PAYLOAD_ENCRYPTION_KEY must be ${HEX_KEY_LENGTH} hex chars (${KEY_LENGTH_BYTES} bytes), got ${keyHex.length}`,
		);
		return false;
	}

	let keyBytes: Uint8Array;
	try {
		keyBytes = hexToBytes(keyHex);
	} catch (err) {
		log.error("Invalid PAYLOAD_ENCRYPTION_KEY:", err);
		return false;
	}

	try {
		// Copy into a fresh ArrayBuffer to satisfy SubtleCrypto's BufferSource type
		// (rules out SharedArrayBuffer-backed views).
		const keyBuffer = new ArrayBuffer(keyBytes.length);
		new Uint8Array(keyBuffer).set(keyBytes);
		encryptionKey = await crypto.subtle.importKey(
			"raw",
			keyBuffer,
			{ name: ALGORITHM, length: KEY_LENGTH_BITS },
			false,
			["encrypt", "decrypt"],
		);
		log.info("Payload encryption enabled (AES-256-GCM)");
		return true;
	} catch (err) {
		log.error("Failed to import encryption key:", err);
		return false;
	}
}

/**
 * Encrypt raw bytes for the binary (BLOB) storage path.
 *
 * Returns the bytes to store plus whether encryption was actually applied —
 * the caller needs that flag to build the envelope's flags byte. When no key
 * is configured the input is returned untouched with `encrypted: false`.
 *
 * The returned layout is `iv || ciphertext || authTag`, exactly the body of
 * the legacy `enc:` envelope but without the base64 expansion.
 */
export async function encryptPayloadBytes(plaintext: Uint8Array): Promise<{
	bytes: Uint8Array;
	encrypted: boolean;
}> {
	await initPayloadEncryption();
	if (!encryptionKey) return { bytes: plaintext, encrypted: false };

	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv },
		encryptionKey,
		toArrayBuffer(plaintext),
	);

	const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), IV_LENGTH);
	return { bytes: combined, encrypted: true };
}

/**
 * Decrypt raw bytes produced by `encryptPayloadBytes`.
 *
 * Throws on:
 *  - no key configured (data is unreadable, fail loudly)
 *  - GCM authentication failure (wrong key OR tampering — never silently
 *    return cipher text, that would corrupt downstream JSON.parse)
 */
export async function decryptPayloadBytes(
	payload: Uint8Array,
): Promise<Uint8Array> {
	await initPayloadEncryption();

	if (!encryptionKey) {
		throw new Error(
			"Encrypted payload found but PAYLOAD_ENCRYPTION_KEY is not configured",
		);
	}
	if (payload.length <= IV_LENGTH) {
		throw new Error(
			"Encrypted payload is too short to contain IV + ciphertext",
		);
	}

	const iv = payload.subarray(0, IV_LENGTH);
	const ciphertext = payload.subarray(IV_LENGTH);
	const decrypted = await crypto.subtle.decrypt(
		{ name: ALGORITHM, iv: toArrayBuffer(iv) },
		encryptionKey,
		toArrayBuffer(ciphertext),
	);
	return new Uint8Array(decrypted);
}

/**
 * Encrypt a UTF-8 string. When encryption is disabled, returns the input
 * unchanged (no `enc:` prefix). Throws if the underlying Web Crypto call
 * fails — callers should let this propagate so a write error is observable
 * rather than silently storing plaintext.
 *
 * Awaits `initPayloadEncryption()` first so callers (especially Bun workers,
 * which have isolated module scopes) cannot accidentally skip initialization
 * and silently store plaintext when a key was set. The init promise is cached,
 * so this is a no-op after the first successful call.
 */
export async function encryptPayload(plaintext: string): Promise<string> {
	await initPayloadEncryption();
	if (!encryptionKey) return plaintext;

	const { bytes } = await encryptPayloadBytes(
		new TextEncoder().encode(plaintext),
	);
	return ENC_PREFIX + Buffer.from(bytes).toString("base64");
}

/**
 * Decrypt a stored payload. Plaintext (no `enc:` prefix) passes through so
 * pre-encryption rows remain readable.
 *
 * Throws on:
 *  - encrypted payload + no key configured (data is unreadable, fail loudly)
 *  - GCM authentication failure (wrong key OR tampering — never silently
 *    return cipher text, that would corrupt downstream JSON.parse)
 *
 * Awaits `initPayloadEncryption()` so the key is loaded before the prefix
 * check decides between pass-through and decrypt; see `encryptPayload`.
 */
export async function decryptPayload(stored: string): Promise<string> {
	await initPayloadEncryption();
	if (!stored.startsWith(ENC_PREFIX)) return stored;

	const bytes = await decryptPayloadBytes(
		new Uint8Array(Buffer.from(stored.slice(ENC_PREFIX.length), "base64")),
	);
	return new TextDecoder().decode(bytes);
}

/**
 * Encode a JSON payload into the legacy text envelope.
 *
 * Legacy only: the repository writes the binary envelope instead (see
 * `payload-blob.ts`), which stores the same compressed/encrypted bytes
 * without the base64 expansion. This function is kept for the legacy format
 * — decoding pre-blob rows, and writing legacy rows if a rollback needs it.
 *
 * It compresses (always, when it helps) and then encrypts (only when a key is
 * configured). Keeping the composition here means a future read path cannot accidentally
 * decrypt without also decompressing, or vice versa.
 */
export async function encodePayloadForStorage(json: string): Promise<string> {
	return encryptPayload(compressPayload(json));
}

/**
 * Decode a stored payload back to its JSON string. Reverses
 * `encodePayloadForStorage`: decrypt (pass-through when unencrypted), then
 * decompress (pass-through for legacy uncompressed bodies).
 *
 * A legacy row — plaintext JSON, or ciphertext wrapping uncompressed JSON —
 * round-trips unchanged, so no migration of existing payloads is required.
 *
 * Throws on the same conditions as `decryptPayload` (encrypted row with no key,
 * or GCM auth failure), plus on corrupt `zst:`-marked data.
 */
export async function decodePayloadFromStorage(
	stored: string,
): Promise<string> {
	return decompressPayload(await decryptPayload(stored));
}

/** Returns true when a key has been imported and encryption is active. */
export function isEncryptionEnabled(): boolean {
	return encryptionKey !== null;
}

function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) {
		throw new Error("Hex string must have even length");
	}
	if (!/^[0-9a-fA-F]+$/.test(hex)) {
		throw new Error("Hex string contains non-hex characters");
	}
	return new Uint8Array(Buffer.from(hex, "hex"));
}

/**
 * Copy bytes into a fresh ArrayBuffer.
 *
 * Web Crypto's `BufferSource` type requires an `ArrayBuffer`-backed view, and
 * a `Buffer` may sit on a pooled (SharedArrayBuffer) backing store, so views
 * taken straight from a Buffer are rejected by the type checker. Copying also
 * detaches the value from the caller's buffer, so later mutation of the
 * source cannot change what was handed to the cipher.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}
