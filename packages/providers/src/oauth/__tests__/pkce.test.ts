import { describe, expect, it } from "bun:test";
import { generatePKCE } from "../pkce";

describe("4. PKCE and State Security Tests", () => {
	describe("PKCE Generation", () => {
		it("should generate valid PKCE verifier and challenge", async () => {
			const pkce = await generatePKCE();

			expect(pkce).toHaveProperty("verifier");
			expect(pkce).toHaveProperty("challenge");
			expect(typeof pkce.verifier).toBe("string");
			expect(typeof pkce.challenge).toBe("string");

			// Verify verifier length (43 chars for 32 random bytes with base64url)
			expect(pkce.verifier.length).toBe(43);

			// Verify verifier contains only valid base64url characters
			expect(pkce.verifier).toMatch(/^[a-zA-Z0-9_-]+$/);

			// Verify challenge is also valid base64url
			expect(pkce.challenge).toMatch(/^[a-zA-Z0-9_-]+$/);

			// Verify challenge is different from verifier (SHA-256 hash)
			expect(pkce.challenge).not.toBe(pkce.verifier);

			// Verify challenge length (43 chars for SHA-256 hash)
			expect(pkce.challenge.length).toBe(43);
		});

		it("should generate unique PKCE pairs each time", async () => {
			const pkce1 = await generatePKCE();
			const pkce2 = await generatePKCE();

			expect(pkce1.verifier).not.toBe(pkce2.verifier);
			expect(pkce1.challenge).not.toBe(pkce2.challenge);
		});

		it("should validate PKCE challenge calculation", async () => {
			const pkce = await generatePKCE();

			const encoder = new TextEncoder();
			const data = encoder.encode(pkce.verifier);
			const hashBuffer = await crypto.subtle.digest("SHA-256", data);

			const hashArray = new Uint8Array(hashBuffer);
			const base64 = btoa(String.fromCharCode(...hashArray));
			const expectedChallenge = base64
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=/g, "");

			expect(pkce.challenge).toBe(expectedChallenge);
		});
	});
});
