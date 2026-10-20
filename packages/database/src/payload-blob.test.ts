/**
 * Unit coverage for the binary payload envelope (`payload-blob.ts`).
 *
 * The text codec's unit tests live in payload-compression.test.ts and
 * payload-encryption.test.ts; this file pins the binary envelope that the
 * repository actually stores — in particular that it carries the same
 * compression/encryption semantics without the base64 inflation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	decodePayloadBlob,
	decodeStoredPayload,
	encodePayloadBlob,
	PAYLOAD_FLAG_COMPRESSED,
	PAYLOAD_FLAG_ENCRYPTED,
	toStoredBytes,
} from "./payload-blob";

/** Conversation-history shaped payload: large and repetitive, so it compresses. */
function largePayload(): string {
	return JSON.stringify({
		model: "claude-sonnet-4-5",
		messages: Array.from({ length: 100 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `Turn ${i}: ${"the quick brown fox jumps over the lazy dog ".repeat(20)}`,
		})),
	});
}

describe("payload blob envelope", () => {
	it("round-trips a large payload", async () => {
		const json = largePayload();
		const encoded = await encodePayloadBlob(json);
		expect(await decodePayloadBlob(encoded)).toBe(json);
	});

	it("round-trips a small payload", async () => {
		const json = JSON.stringify({ a: 1 });
		const encoded = await encodePayloadBlob(json);
		expect(await decodePayloadBlob(encoded)).toBe(json);
	});

	it("round-trips an empty payload", async () => {
		const encoded = await encodePayloadBlob("");
		expect(await decodePayloadBlob(encoded)).toBe("");
	});

	it("marks a compressible payload with the COMPRESSED flag", async () => {
		const encoded = await encodePayloadBlob(largePayload());
		expect(encoded[0] & PAYLOAD_FLAG_COMPRESSED).toBe(PAYLOAD_FLAG_COMPRESSED);
	});

	it("does not compress a payload that is already tiny", async () => {
		const encoded = await encodePayloadBlob(JSON.stringify({ a: 1 }));
		expect(encoded[0] & PAYLOAD_FLAG_COMPRESSED).toBe(0);
	});

	it("stores fewer bytes than the base64 text format did", async () => {
		const json = largePayload();
		const encoded = await encodePayloadBlob(json);

		// The legacy text envelope was `zst:` + base64(zstd(json)) — base64
		// inflates by 4/3. The binary envelope stores the frame as-is.
		const legacyLength =
			"zst:".length +
			4 * Math.ceil(Bun.zstdCompressSync(Buffer.from(json)).length / 3);

		expect(encoded.length).toBeLessThan(legacyLength);
		expect(encoded.length).toBeLessThan(json.length);
	});

	it("never inflates a payload", async () => {
		// Incompressible input (random bytes as a string) must not grow.
		const random = Array.from({ length: 4096 }, () =>
			String.fromCharCode(Math.floor(Math.random() * 0x10000)),
		).join("");
		const encoded = await encodePayloadBlob(random);
		expect(encoded.length).toBeLessThanOrEqual(
			new TextEncoder().encode(random).length,
		);
	});

	it("throws on an empty envelope", async () => {
		expect(decodePayloadBlob(new Uint8Array(0))).rejects.toThrow();
	});

	it("throws on a corrupt compressed body", async () => {
		const encoded = await encodePayloadBlob(largePayload());
		// Keep the COMPRESSED flag, garbage the frame.
		encoded[1] = 0xff;
		encoded[2] = 0xff;
		encoded[3] = 0xff;
		expect(decodePayloadBlob(encoded)).rejects.toThrow();
	});
});

describe("payload blob envelope with encryption enabled", () => {
	const KEY_A =
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	const KEY_B =
		"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

	beforeEach(() => {
		process.env.PAYLOAD_ENCRYPTION_KEY = KEY_A;
	});

	afterEach(() => {
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
	});

	it("round-trips an encrypted payload", async () => {
		const json = largePayload();
		const encoded = await encodePayloadBlob(json);
		expect(encoded[0] & PAYLOAD_FLAG_ENCRYPTED).toBe(PAYLOAD_FLAG_ENCRYPTED);
		expect(await decodePayloadBlob(encoded)).toBe(json);
	});

	it("stores the ciphertext, not the plaintext", async () => {
		const json = largePayload();
		const encoded = await encodePayloadBlob(json);
		const asText = new TextDecoder().decode(encoded);
		// The plaintext must not be sitting in the row in the clear.
		expect(asText).not.toContain(json.slice(0, 200));
	});

	it("uses the new key after PAYLOAD_ENCRYPTION_KEY changes", async () => {
		// A restart with a rotated key must not leave new rows unreadable:
		// the codec has to pick up the new key rather than keep using the
		// one it imported first.
		const json = JSON.stringify({ secret: true });
		const withKeyA = await encodePayloadBlob(json);

		process.env.PAYLOAD_ENCRYPTION_KEY = KEY_B;
		const withKeyB = await encodePayloadBlob(json);

		expect(withKeyB).not.toEqual(withKeyA);
		expect(await decodePayloadBlob(withKeyB)).toBe(json);
		// The row written under the old key must NOT decrypt under the new
		// one — that is what proves the key actually switched.
		await expect(decodePayloadBlob(withKeyA)).rejects.toThrow();
	});

	it("stops encrypting once the key is removed", async () => {
		const json = JSON.stringify({ secret: true });
		const encrypted = await encodePayloadBlob(json);
		expect(encrypted[0] & PAYLOAD_FLAG_ENCRYPTED).toBe(PAYLOAD_FLAG_ENCRYPTED);

		delete process.env.PAYLOAD_ENCRYPTION_KEY;

		const plaintext = await encodePayloadBlob(json);
		expect(plaintext[0] & PAYLOAD_FLAG_ENCRYPTED).toBe(0);
		expect(await decodePayloadBlob(plaintext)).toBe(json);
		// The stale key must be dropped, not kept around: the row written
		// under it is now unreadable rather than silently decryptable.
		await expect(decodePayloadBlob(encrypted)).rejects.toThrow();
	});
});

describe("toStoredBytes", () => {
	it("passes a Uint8Array through", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(toStoredBytes(bytes)).toBe(bytes);
	});

	it("returns null for SQL NULL", () => {
		expect(toStoredBytes(null)).toBeNull();
		expect(toStoredBytes(undefined)).toBeNull();
	});

	it("decodes PostgreSQL's text-format bytea", () => {
		expect(toStoredBytes("\\x0102ff")).toEqual(new Uint8Array([1, 2, 255]));
	});

	it("rejects an unexpected value type", () => {
		expect(() => toStoredBytes(42)).toThrow();
	});
});

describe("decodeStoredPayload", () => {
	it("prefers the binary envelope", async () => {
		const json = JSON.stringify({ hello: "world" });
		const encoded = await encodePayloadBlob(json);
		expect(await decodeStoredPayload(encoded, "")).toBe(json);
	});

	it("falls back to the legacy text column", async () => {
		// A pre-blob row: `json` holds the legacy envelope, `payload` is NULL.
		const legacy = JSON.stringify({ legacy: true });
		expect(await decodeStoredPayload(null, legacy)).toBe(legacy);
	});

	it("decodes a legacy compressed text row", async () => {
		const json = largePayload();
		const compressed = Bun.zstdCompressSync(Buffer.from(json));
		const legacy = `zst:${Buffer.from(compressed).toString("base64")}`;
		expect(await decodeStoredPayload(null, legacy)).toBe(json);
	});
});
