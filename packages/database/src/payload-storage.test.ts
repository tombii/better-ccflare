import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	decodePayloadFromStorage,
	encodePayloadForStorage,
} from "./payload-storage";

describe("payload storage encode/decode", () => {
	beforeEach(() => {
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
	});

	afterEach(() => {
		delete process.env.PAYLOAD_ENCRYPTION_KEY;
	});

	it("round-trips compressed plaintext when encryption is disabled", async () => {
		const plain = '{"request":{"body":"x"},"response":null}';
		const { stored, compressed } = await encodePayloadForStorage(plain);
		expect(compressed).toBe(true);
		expect(stored).not.toBe(plain);

		const decoded = await decodePayloadFromStorage(stored, compressed);
		expect(decoded).toBe(plain);
	});

	it("reads legacy uncompressed plaintext rows", async () => {
		const legacy = '{"legacy":true}';
		const decoded = await decodePayloadFromStorage(legacy, false);
		expect(decoded).toBe(legacy);
	});
});
