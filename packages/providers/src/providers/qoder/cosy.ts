import {
	constants,
	createCipheriv,
	createHash,
	publicEncrypt,
	randomBytes,
} from "node:crypto";

/**
 * Qoder's COSY request envelope.
 *
 * The gateway (api3.qoder.sh/algo/...) does not accept a bearer token or a
 * plain JSON body. Every request is signed: an AES-128-CBC-wrapped identity is
 * RSA-encrypted into a per-request key, the body is transformed through a
 * custom base64 codec, and both are tied together with an MD5 signature over
 * (payload, key, timestamp, body, path). Reference: QODER_INTEGRATION.md §4.
 */

const STANDARD_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET =
	"_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

/**
 * Qoder's published 1024-bit RSA key. The gateway holds the private half.
 * This is a signing envelope, not a confidentiality boundary: the identity it
 * wraps is only echoed back to Qoder itself.
 */
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * The CLI pairing. The desktop client sends `1.1.69`/`10`; the server may
 * enforce the pairing, and `1.0.0`/`5` is the combination verified against
 * both the model list and chat on a real account.
 */
export const QODER_COSY_VERSION = "1.0.0";
export const QODER_COSY_CLIENT_TYPE = "5";

export interface QoderCosyCreds {
	/** The account's uid, from GET /api/v1/userinfo. */
	uid: string;
	/** The `jt-` job token minted by the PAT exchange. */
	token: string;
	name?: string;
	email?: string;
}

/**
 * The machine id Qoder sees. The CLI persists one per installation; here it is
 * derived from the uid so it is stable across processes and restarts for an
 * account (a fresh random id per request or per process looks like a fleet of
 * clients on one credential).
 */
export function deriveQoderMachineId(uid: string): string {
	const hex = createHash("sha256")
		.update(`better-ccflare:qoder-machine:v1\0${uid}`)
		.digest("hex");
	const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface QoderCosyHeaders {
	headers: Record<string, string>;
	/** Exposed for tests and diagnostics; the gateway only sees the headers. */
	payload: string;
	signature: string;
	cosyKey: string;
	timestamp: string;
	aesKey: string;
}

/**
 * Transform a UTF-8 body into the wire form Qoder expects: standard base64,
 * rotated by thirds, with every character substituted through Qoder's
 * alphabet and `=` written as `$`.
 */
export function encodeQoderBody(plaintext: string): string {
	const base64 = Buffer.from(plaintext, "utf8").toString("base64");
	const n = base64.length;
	const a = Math.floor(n / 3);

	// Rotation by thirds: the last a chars, then the middle, then the first a.
	const rearranged =
		base64.slice(n - a) + base64.slice(a, n - a) + base64.slice(0, a);

	let out = "";
	for (const ch of rearranged) {
		if (ch === "=") {
			out += "$";
			continue;
		}
		const idx = STANDARD_ALPHABET.indexOf(ch);
		out += idx >= 0 ? QODER_ALPHABET[idx] : ch;
	}
	return out;
}

/**
 * The inverse of {@link encodeQoderBody}: the wire form back to the JSON it
 * came from. Used by the tests and by diagnostics — the body is opaque to
 * everything else.
 */
export function decodeQoderBody(encoded: string): string {
	let base64 = "";
	for (const ch of encoded) {
		if (ch === "$") {
			base64 += "=";
			continue;
		}
		const idx = QODER_ALPHABET.indexOf(ch);
		base64 += idx >= 0 ? STANDARD_ALPHABET[idx] : ch;
	}
	const n = base64.length;
	const a = Math.floor(n / 3);
	// The rotation is its own inverse.
	const restored =
		base64.slice(n - a) + base64.slice(a, n - a) + base64.slice(0, a);
	return Buffer.from(restored, "base64").toString("utf8");
}

/** The pathname the signature covers: no query, and no leading `/algo`. */
export function cosySignaturePath(url: string): string {
	const path = new URL(url).pathname;
	return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}

function randomHex16(): string {
	return randomBytes(8).toString("hex");
}

/**
 * Build the signed envelope for one request.
 *
 * @param url - The full target URL (its pathname is what gets signed)
 * @param body - The **encoded** body exactly as it will be sent; empty for GETs
 */
export function buildCosyHeaders(opts: {
	url: string;
	body: string;
	creds: QoderCosyCreds;
	machineId: string;
	/**
	 * The request id. ONE uuid identifies the request in the COSY payload, in
	 * the `X-Request-Id` header and in the request body — three different
	 * uuids for one request make the upstream's logs disagree with ours.
	 */
	requestId?: string;
}): QoderCosyHeaders {
	const { url, body, creds, machineId } = opts;
	const requestId = opts.requestId ?? crypto.randomUUID();

	const aesKey = randomHex16();
	const cipher = createCipheriv(
		"aes-128-cbc",
		Buffer.from(aesKey),
		Buffer.from(aesKey),
	);
	const info = Buffer.concat([
		cipher.update(
			JSON.stringify({
				uid: creds.uid,
				security_oauth_token: creds.token,
				name: creds.name ?? "",
				aid: "",
				email: creds.email ?? "",
			}),
			"utf8",
		),
		cipher.final(),
	]).toString("base64");

	const cosyKey = publicEncrypt(
		{ key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
		Buffer.from(aesKey),
	).toString("base64");

	const timestamp = Math.floor(Date.now() / 1000).toString();
	const payload = Buffer.from(
		JSON.stringify({
			version: "v1",
			requestId,
			info,
			cosyVersion: QODER_COSY_VERSION,
			ideVersion: "",
		}),
	).toString("base64");

	const sigPath = cosySignaturePath(url);
	const bodyBuf = Buffer.from(body, "utf8");
	const signature = createHash("md5")
		.update(`${payload}\n${cosyKey}\n${timestamp}\n${body}\n${sigPath}`)
		.digest("hex");

	return {
		headers: {
			Authorization: `Bearer COSY.${payload}.${signature}`,
			"Cosy-Key": cosyKey,
			"Cosy-User": creds.uid,
			"Cosy-Date": timestamp,
			"Cosy-Version": QODER_COSY_VERSION,
			"Cosy-Machineid": machineId,
			"Cosy-Machinetoken": machineId,
			"Cosy-Machinetype": "5",
			"Cosy-Machineos": "x86_64_windows",
			"Cosy-Clienttype": QODER_COSY_CLIENT_TYPE,
			"Cosy-Clientip": "127.0.0.1",
			"Cosy-Bodyhash": createHash("md5").update(bodyBuf).digest("hex"),
			"Cosy-Bodylength": String(bodyBuf.length),
			"Cosy-Sigpath": sigPath,
			"Cosy-Data-Policy": "disagree",
			"Cosy-Organization-Id": "",
			"Cosy-Organization-Tags": "",
			"Login-Version": "v2",
			"X-Request-Id": requestId,
		},
		payload,
		signature,
		cosyKey,
		timestamp,
		aesKey,
	};
}
