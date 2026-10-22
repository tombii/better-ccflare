import { createDecipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
	buildCosyHeaders,
	cosySignaturePath,
	encodeQoderBody,
	QODER_COSY_VERSION,
	QODER_COSY_CLIENT_TYPE,
} from "../cosy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STD_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The inverse of Qoder's body codec, written independently from the
 * implementation: undo the alphabet substitution and the three-way rotation,
 * then base64-decode. Proving encode∘decode is the identity for arbitrary
 * input is stronger than any single pinned string.
 */
function decodeQoderBody(encoded: string): string {
	const custom =
		"_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
	let std = "";
	for (const ch of encoded) {
		if (ch === "$") {
			std += "=";
			continue;
		}
		const idx = custom.indexOf(ch);
		std += idx >= 0 ? STD_ALPHABET[idx] : ch;
	}
	const n = std.length;
	const a = Math.floor(n / 3);
	// rotate was: out = s[n-a:] + s[a:n-a] + s[:a], so undo it in three named
	// slices rather than by index arithmetic.
	const rotated = std;
	const tail = rotated.slice(0, a); // original[n-a:n]
	const middle = rotated.slice(a, n - a); // original[a:n-a]
	const head = rotated.slice(n - a); // original[0:a]
	return Buffer.from(head + middle + tail, "base64").toString("utf8");
}

// ---------------------------------------------------------------------------
// Body codec
// ---------------------------------------------------------------------------

describe("encodeQoderBody", () => {
	it("round-trips arbitrary JSON-like payloads through the published codec", () => {
		const samples = [
			"",
			"{}",
			'{"a":1}',
			'{"model":"qfmodel","messages":[{"role":"user","content":"héllo ✓ 你好"}]}',
			JSON.stringify({ long: "x".repeat(1000) }),
			Buffer.from([0x00, 0x01, 0xfe, 0xff]).toString("utf8"),
		];
		for (const sample of samples) {
			expect(decodeQoderBody(encodeQoderBody(sample))).toBe(sample);
		}
	});

	it("maps standard base64 padding to $", () => {
		// "a" -> "YQ==" — two padding characters.
		expect(encodeQoderBody("a")).not.toContain("=");
		expect(decodeQoderBody(encodeQoderBody("a"))).toBe("a");
	});

	it("keeps the encoded length equal to the base64 length", () => {
		const plaintext = '{"x":"hello"}';
		const base64Length = Buffer.from(plaintext).toString("base64").length;
		expect(encodeQoderBody(plaintext)).toHaveLength(base64Length);
	});

	it("only emits characters from the custom alphabet or $", () => {
		const encoded = encodeQoderBody(
			JSON.stringify({ nested: { list: [1, 2, 3], text: "abc" } }),
		);
		const allowed = new Set(
			"_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$".split(
				"",
			),
		);
		for (const ch of encoded) {
			expect(allowed.has(ch)).toBe(true);
		}
	});
});

describe("cosySignaturePath", () => {
	it("strips a leading /algo and drops the query string", () => {
		expect(
			cosySignaturePath(
				"https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1",
			),
		).toBe("/api/v2/service/pro/sse/agent_chat_generation");
	});

	it("leaves a path without /algo intact", () => {
		expect(cosySignaturePath("https://api3.qoder.sh/api/v2/model/list")).toBe(
			"/api/v2/model/list",
		);
	});

	it("only strips a leading /algo, never an inner occurrence", () => {
		expect(cosySignaturePath("https://x.example/api/algo/x")).toBe(
			"/api/algo/x",
		);
	});
});

// ---------------------------------------------------------------------------
// Signed headers
// ---------------------------------------------------------------------------

const CREDS = {
	uid: "u-123",
	token: "jt-abc.def",
	name: "",
	email: "",
};

const URL_WITH_BODY =
	"https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

describe("buildCosyHeaders", () => {
	it("produces the exact header set the gateway requires", () => {
		const { headers } = buildCosyHeaders({
			url: URL_WITH_BODY,
			body: "ENCODEDBODY",
			creds: CREDS,
			machineId: "11111111-2222-3333-4444-555555555555",
		});
		expect(Object.keys(headers).sort()).toEqual(
			[
				"Authorization",
				"Cosy-Bodyhash",
				"Cosy-Bodylength",
				"Cosy-Clientip",
				"Cosy-Clienttype",
				"Cosy-Data-Policy",
				"Cosy-Date",
				"Cosy-Key",
				"Cosy-Machineid",
				"Cosy-Machineos",
				"Cosy-Machinetoken",
				"Cosy-Machinetype",
				"Cosy-Organization-Id",
				"Cosy-Organization-Tags",
				"Cosy-Sigpath",
				"Cosy-User",
				"Cosy-Version",
				"Login-Version",
				"X-Request-Id",
			].sort(),
		);
		expect(headers["Cosy-User"]).toBe("u-123");
		expect(headers["Cosy-Version"]).toBe(QODER_COSY_VERSION);
		expect(headers["Cosy-Clienttype"]).toBe(QODER_COSY_CLIENT_TYPE);
		expect(headers["Cosy-Machineos"]).toBe("x86_64_windows");
		expect(headers["Cosy-Machinetype"]).toBe("5");
		expect(headers["Cosy-Clientip"]).toBe("127.0.0.1");
		expect(headers["Cosy-Data-Policy"]).toBe("disagree");
		expect(headers["Cosy-Organization-Id"]).toBe("");
		expect(headers["Cosy-Organization-Tags"]).toBe("");
		expect(headers["Login-Version"]).toBe("v2");
		expect(headers["Cosy-Machineid"]).toBe(
			"11111111-2222-3333-4444-555555555555",
		);
		expect(headers["Cosy-Machinetoken"]).toBe(headers["Cosy-Machineid"]);
		expect(headers["X-Request-Id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("hashes and measures the encoded body, not the plaintext", () => {
		const body = "aGVsbG8$";
		const { headers } = buildCosyHeaders({
			url: URL_WITH_BODY,
			body,
			creds: CREDS,
			machineId: "m",
		});
		expect(headers["Cosy-Bodyhash"]).toBe(
			createHash("md5").update(body).digest("hex"),
		);
		expect(headers["Cosy-Bodylength"]).toBe(String(body.length));
		expect(headers["Cosy-Sigpath"]).toBe(
			"/api/v2/service/pro/sse/agent_chat_generation",
		);
	});

	it("signs with the documented MD5 construction over payload, key, date, body and path", () => {
		const body = "encoded";
		const { headers, signature, payload, cosyKey, timestamp } =
			buildCosyHeaders({
				url: URL_WITH_BODY,
				body,
				creds: CREDS,
				machineId: "m",
			});
		expect(signature).toBe(
			createHash("md5")
				.update(
					`${payload}\n${cosyKey}\n${timestamp}\n${body}\n/api/v2/service/pro/sse/agent_chat_generation`,
				)
				.digest("hex"),
		);
		expect(headers.Authorization).toBe(`Bearer COSY.${payload}.${signature}`);
	});

	it("uses unix seconds for Cosy-Date", () => {
		const before = Math.floor(Date.now() / 1000);
		const { headers } = buildCosyHeaders({
			url: URL_WITH_BODY,
			body: "x",
			creds: CREDS,
			machineId: "m",
		});
		const after = Math.floor(Date.now() / 1000);
		const ts = Number(headers["Cosy-Date"]);
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
		expect(headers["Cosy-Date"]).toBe(String(ts));
	});

	it("packs the identity into an AES-128-CBC payload recoverable with the RSA-wrapped key", () => {
		// The gateway unwraps cosyKey with its private key and decrypts `info`.
		// We cannot RSA-decrypt here, but we can recover the AES key from the
		// builder's return value and prove the round trip of the identity.
		const { payload, aesKey } = buildCosyHeaders({
			url: URL_WITH_BODY,
			body: "x",
			creds: { uid: "u-1", token: "jt-1", name: "n", email: "e@x" },
			machineId: "m",
		});
		const outer = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
		expect(outer.version).toBe("v1");
		expect(outer.ideVersion).toBe("");
		expect(outer.cosyVersion).toBe(QODER_COSY_VERSION);
		expect(typeof outer.requestId).toBe("string");

		const decipher = createDecipheriv(
			"aes-128-cbc",
			Buffer.from(aesKey),
			Buffer.from(aesKey),
		);
		const info = JSON.parse(
			decipher.update(Buffer.from(outer.info, "base64"), undefined, "utf8") +
				decipher.final("utf8"),
		);
		expect(info).toEqual({
			uid: "u-1",
			security_oauth_token: "jt-1",
			name: "n",
			aid: "",
			email: "e@x",
		});
	});

	it("uses a fresh 16-character hex AES key and request payload per call", () => {
		const a = buildCosyHeaders({
			url: URL_WITH_BODY,
			body: "x",
			creds: CREDS,
			machineId: "m",
		});
		const b = buildCosyHeaders({
			url: URL_WITH_BODY,
			body: "x",
			creds: CREDS,
			machineId: "m",
		});
		expect(a.aesKey).toMatch(/^[0-9a-f]{16}$/);
		expect(a.aesKey).not.toBe(b.aesKey);
		expect(a.payload).not.toBe(b.payload);
		expect(a.cosyKey).not.toBe(b.cosyKey);
		// cosyKey is a base64 RSA (1024-bit) block.
		expect(Buffer.from(a.cosyKey, "base64")).toHaveLength(128);
	});

	it("wraps an empty body correctly (the model-list GET)", () => {
		const { headers } = buildCosyHeaders({
			url: "https://api3.qoder.sh/algo/api/v2/model/list",
			body: "",
			creds: CREDS,
			machineId: "m",
		});
		expect(headers["Cosy-Bodylength"]).toBe("0");
		expect(headers["Cosy-Bodyhash"]).toBe(
			createHash("md5").update("").digest("hex"),
		);
	});
});
