import { compressPayload, decompressPayload } from "./payload-compression";
import { decryptPayload, encryptPayload } from "./payload-encryption";

export interface EncodedPayload {
	stored: string;
	compressed: boolean;
}

/** gzip then optionally encrypt for durable `request_payloads.json` storage. */
export async function encodePayloadForStorage(
	plaintext: string,
): Promise<EncodedPayload> {
	const compressedBody = compressPayload(plaintext);
	const stored = await encryptPayload(compressedBody);
	return { stored, compressed: true };
}

/**
 * Reverse {@link encodePayloadForStorage}.
 * When `compressed` is false, `stored` is legacy plaintext or encrypted JSON.
 */
export async function decodePayloadFromStorage(
	stored: string,
	compressed: boolean,
): Promise<string> {
	const decrypted = await decryptPayload(stored);
	if (!compressed) return decrypted;
	return decompressPayload(decrypted);
}
