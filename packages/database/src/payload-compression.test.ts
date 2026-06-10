import { describe, expect, it } from "bun:test";
import { compressPayload, decompressPayload } from "./payload-compression";

describe("payload compression", () => {
	it("round-trips a JSON payload", () => {
		const plain = JSON.stringify({
			request: { body: "aGVsbG8=", headers: {} },
			response: { status: 200, body: null },
		});
		const compressed = compressPayload(plain);
		expect(compressed).not.toBe(plain);
		expect(decompressPayload(compressed)).toBe(plain);
	});

	it("round-trips a large repetitive payload smaller than plaintext", () => {
		const plain = JSON.stringify({
			messages: Array.from({ length: 500 }, (_, i) => ({
				role: "user",
				content: `message-${i} `.repeat(40),
			})),
		});
		const compressed = compressPayload(plain);
		expect(Buffer.byteLength(compressed, "utf8")).toBeLessThan(
			Buffer.byteLength(plain, "utf8"),
		);
		expect(decompressPayload(compressed)).toBe(plain);
	});

	it("round-trips an empty JSON object", () => {
		const plain = "{}";
		expect(decompressPayload(compressPayload(plain))).toBe(plain);
	});
});
