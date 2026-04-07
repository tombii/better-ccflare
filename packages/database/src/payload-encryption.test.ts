import { afterEach, beforeEach, describe, expect, it } from "bun:test";

// We deliberately re-import the module fresh per test so module-level state
// (encryptionKey, initPromise) doesn't leak between cases. The dynamic import
// + cache bust pattern is the only way to reset Bun module singletons in tests.
let modCounter = 0;
async function loadFreshModule() {
	modCounter += 1;
	// Append a query string to bust Bun's module cache.
	return await import(`./payload-encryption?fresh=${modCounter}`);
}

const VALID_HEX_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("payload encryption", () => {
	beforeEach(() => {
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
	});

	afterEach(() => {
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
	});

	it("passes through plaintext when no key is configured", async () => {
		const mod = await loadFreshModule();
		const enabled = await mod.initPayloadEncryption();
		expect(enabled).toBe(false);
		expect(mod.isEncryptionEnabled()).toBe(false);

		const plain = '{"hello":"world"}';
		const encrypted = await mod.encryptPayload(plain);
		expect(encrypted).toBe(plain); // pass-through
		const decrypted = await mod.decryptPayload(encrypted);
		expect(decrypted).toBe(plain);
	});

	it("round-trips a payload when a key is configured", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		const enabled = await mod.initPayloadEncryption();
		expect(enabled).toBe(true);
		expect(mod.isEncryptionEnabled()).toBe(true);

		const plain = '{"sensitive":"value","n":42}';
		const encrypted = await mod.encryptPayload(plain);
		expect(encrypted).not.toBe(plain);
		expect(encrypted.startsWith("enc:")).toBe(true);

		const decrypted = await mod.decryptPayload(encrypted);
		expect(decrypted).toBe(plain);
	});

	it("produces a different ciphertext for the same plaintext (random IV)", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();

		const plain = "same input";
		const a = await mod.encryptPayload(plain);
		const b = await mod.encryptPayload(plain);
		expect(a).not.toBe(b);
		expect(await mod.decryptPayload(a)).toBe(plain);
		expect(await mod.decryptPayload(b)).toBe(plain);
	});

	it("decrypts pre-encryption plaintext rows transparently", async () => {
		// Operator enables encryption AFTER having plaintext rows in the DB.
		// Those rows must remain readable.
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();

		const legacyRow = '{"this":"was stored before encryption was enabled"}';
		expect(await mod.decryptPayload(legacyRow)).toBe(legacyRow);
	});

	it("rejects a key with the wrong length", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = "tooshort";
		const mod = await loadFreshModule();
		const enabled = await mod.initPayloadEncryption();
		expect(enabled).toBe(false);
		expect(mod.isEncryptionEnabled()).toBe(false);
	});

	it("rejects a key with non-hex characters", async () => {
		// Same length as a valid key, but contains non-hex chars.
		process.env.PAYLOAD_ENCRYPTION_KEY =
			"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
		const mod = await loadFreshModule();
		const enabled = await mod.initPayloadEncryption();
		expect(enabled).toBe(false);
	});

	it("throws when an encrypted payload is read with no key configured", async () => {
		// First produce a valid encrypted payload with a key.
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const enc = await loadFreshModule();
		await enc.initPayloadEncryption();
		const ciphertext = await enc.encryptPayload('{"x":1}');
		expect(ciphertext.startsWith("enc:")).toBe(true);

		// Now load a fresh module instance with no key — must throw, not silently
		// return cipher text (which would corrupt downstream JSON.parse).
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
		const dec = await loadFreshModule();
		await dec.initPayloadEncryption();
		expect(dec.isEncryptionEnabled()).toBe(false);
		expect(dec.decryptPayload(ciphertext)).rejects.toThrow();
	});

	it("throws on tampered ciphertext (GCM auth tag check)", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();

		const original = await mod.encryptPayload('{"a":"b"}');
		// Flip a byte in the middle of the ciphertext payload.
		const b64 = original.slice("enc:".length);
		const bytes = Buffer.from(b64, "base64");
		bytes[bytes.length - 1] ^= 0xff;
		const tampered = `enc:${bytes.toString("base64")}`;

		expect(mod.decryptPayload(tampered)).rejects.toThrow();
	});

	it("throws on a truncated encrypted payload", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();
		await mod.initPayloadEncryption();

		// 12-byte IV + 0 ciphertext bytes — not even one block of GCM
		// authentication data, so reject before calling subtle.decrypt.
		const onlyIv = `enc:${Buffer.alloc(8).toString("base64")}`;
		expect(mod.decryptPayload(onlyIv)).rejects.toThrow();
	});

	it("init is idempotent — concurrent calls share the same promise", async () => {
		process.env.PAYLOAD_ENCRYPTION_KEY = VALID_HEX_KEY;
		const mod = await loadFreshModule();

		const [a, b, c] = await Promise.all([
			mod.initPayloadEncryption(),
			mod.initPayloadEncryption(),
			mod.initPayloadEncryption(),
		]);
		expect(a).toBe(true);
		expect(b).toBe(true);
		expect(c).toBe(true);
		expect(mod.isEncryptionEnabled()).toBe(true);
	});
});
