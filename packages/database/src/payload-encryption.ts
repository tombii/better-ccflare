import { Logger } from "@better-ccflare/logger";

/**
 * Payload encryption at rest using AES-256-GCM (Web Crypto).
 *
 * Stored format: `enc:` + base64(iv || ciphertext || authTag)
 *
 * - The 12-byte IV is generated per-encryption with `crypto.getRandomValues`.
 * - GCM's authentication tag is appended by `crypto.subtle.encrypt`, so any
 *   tampering or wrong-key decryption fails loudly (the tag check throws).
 * - When `PAYLOAD_ENCRYPTION_KEY` is unset, encrypt is a pass-through and
 *   decrypt accepts plaintext as-is — this keeps existing databases readable
 *   and lets operators opt in without a migration.
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

/**
 * Initialize the payload encryption key from `PAYLOAD_ENCRYPTION_KEY`
 * (a 64-character hex string = 32 bytes = AES-256).
 *
 * Idempotent — concurrent or repeated calls share the same in-flight promise.
 * Returns `true` when encryption is enabled, `false` when no key is configured
 * or initialization failed (the function never throws).
 */
export function initPayloadEncryption(): Promise<boolean> {
	if (initPromise) return initPromise;
	initPromise = doInit();
	return initPromise;
}

async function doInit(): Promise<boolean> {
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

	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encoded = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv },
		encryptionKey,
		encoded,
	);

	const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), IV_LENGTH);
	return ENC_PREFIX + Buffer.from(combined).toString("base64");
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

	if (!encryptionKey) {
		throw new Error(
			"Encrypted payload found but PAYLOAD_ENCRYPTION_KEY is not configured",
		);
	}

	const combined = new Uint8Array(
		Buffer.from(stored.slice(ENC_PREFIX.length), "base64"),
	);
	if (combined.length <= IV_LENGTH) {
		throw new Error(
			"Encrypted payload is too short to contain IV + ciphertext",
		);
	}

	const iv = combined.slice(0, IV_LENGTH);
	const ciphertext = combined.slice(IV_LENGTH);
	const decrypted = await crypto.subtle.decrypt(
		{ name: ALGORITHM, iv },
		encryptionKey,
		ciphertext,
	);
	return new TextDecoder().decode(decrypted);
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
