import { describe, expect, it } from "bun:test";
import {
	COMPRESSED_PREFIX,
	compressPayload,
	decompressPayload,
	isCompressed,
} from "./payload-compression";

/**
 * A realistically-shaped payload: long conversation history with repeated
 * boilerplate, which is what the proxy actually stores (see
 * MAX_REQUEST_BODY_BYTES in usage-collector.ts).
 */
function largeJson(): string {
	return JSON.stringify({
		messages: Array.from({ length: 100 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `Message ${i}: ${"lorem ipsum dolor sit amet ".repeat(20)}`,
		})),
	});
}

/** High-entropy hex, to exercise the "compression did not help" path. */
function randomHex(bytes: number): string {
	const buf = crypto.getRandomValues(new Uint8Array(bytes));
	return Buffer.from(buf).toString("hex");
}

describe("payload compression", () => {
	it("round-trips a large JSON payload", () => {
		const original = largeJson();
		const stored = compressPayload(original);

		expect(stored.startsWith(COMPRESSED_PREFIX)).toBe(true);
		expect(isCompressed(stored)).toBe(true);
		expect(decompressPayload(stored)).toBe(original);
	});

	it("shrinks large repetitive payloads", () => {
		const original = largeJson();
		const stored = compressPayload(original);

		// The whole point of the feature: a large payload must get smaller on
		// disk than its JSON form.
		expect(stored.length).toBeLessThan(original.length);
	});

	it("stores small payloads verbatim", () => {
		// Below the threshold, zstd frame overhead + base64 expansion would make
		// the stored value LARGER, so small payloads must pass through untouched.
		const small = '{"a":1}';
		const stored = compressPayload(small);

		expect(stored).toBe(small);
		expect(isCompressed(stored)).toBe(false);
		expect(decompressPayload(stored)).toBe(small);
	});

	it("never stores a value larger than the original", () => {
		// Invariant: whether the input is tiny, incompressible, or highly
		// repetitive, compressPayload must never inflate it.
		const inputs = ['{"a":1}', "x".repeat(100), randomHex(4000), largeJson()];
		for (const input of inputs) {
			expect(compressPayload(input).length).toBeLessThanOrEqual(input.length);
		}
	});

	it("round-trips unicode content", () => {
		const original = JSON.stringify({
			text: "日本語 🎉 émoji ".repeat(200),
		});
		expect(decompressPayload(compressPayload(original))).toBe(original);
	});

	it("passes through legacy plaintext payloads unchanged", () => {
		// Rows written before compression existed have no prefix and must remain
		// readable without any migration.
		const legacy = '{"legacy":true}';
		expect(isCompressed(legacy)).toBe(false);
		expect(decompressPayload(legacy)).toBe(legacy);
	});

	it("throws on corrupt compressed data", () => {
		// A marked-but-garbage value must fail loudly rather than silently
		// returning junk that breaks downstream JSON.parse.
		const corrupt = `${COMPRESSED_PREFIX}bm90LXZhbGlkLXpkLXN0ZA==`;
		expect(() => decompressPayload(corrupt)).toThrow();
	});
});
