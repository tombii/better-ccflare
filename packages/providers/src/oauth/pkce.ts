import type { PKCEChallenge } from "../types";

/**
 * Generates a PKCE (Proof Key for Code Exchange) challenge for OAuth 2.0 authorization flows
 *
 * **PKCE Security Flow:**
 * 1. Generate a cryptographically random verifier (stored client-side)
 * 2. Create a SHA-256 hash of the verifier (sent to OAuth provider)
 * 3. During token exchange, prove possession of the original verifier
 * 4. Prevents authorization code interception attacks
 *
 * **Security Assumptions:**
 * - Uses Web Crypto API with cryptographically secure random number generator
 * - 32 bytes (256 bits) of entropy for the verifier
 * - SHA-256 provides strong cryptographic hash function
 * - Base64url encoding ensures URL-safe transmission
 * - Verifier is never exposed in URLs or transmitted to the provider
 *
 * **PKCE RFC Compliance:**
 * - Follows RFC 7636 (Proof Key for Code Exchange by OAuth Public Clients)
 * - Uses "S256" (SHA256) code challenge method
 * - Verifier length between 43-128 characters (43 chars for 32 bytes)
 * - Code challenge length equals verifier length after base64url encoding
 *
 * @returns Promise resolving to PKCE challenge object containing verifier and challenge
 *
 * @example
 * ```typescript
 * const pkce = await generatePKCE();
 * console.log(pkce.verifier); // "abcdef123456..." (keep secret)
 * console.log(pkce.challenge); // "xyz789abc..." (send to OAuth provider)
 *
 * // In OAuth URL: &code_challenge=xyz789abc&code_challenge_method=S256
 * // In token exchange: verifier=abcdef123456...
 * ```
 */
export async function generatePKCE(): Promise<PKCEChallenge> {
	// Generate random verifier
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// Calculate SHA-256 challenge
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}

/**
 * Encodes binary data using URL-safe Base64 encoding without padding
 *
 * **URL-Safe Base64 Details:**
 * - Replaces '+' with '-' for URL compatibility
 * - Replaces '/' with '_' for URL compatibility
 * - Removes padding '=' characters to minimize URL length
 * - Maintains RFC 4648 compliance for URL-safe base64 encoding
 *
 * **Security Considerations:**
 * - Properly handles binary data from Web Crypto API
 * - Uses standard browser btoa() function for base64 encoding
 * - Ensures no character conflicts with URL parameter encoding
 * - Maintains bi-directional compatibility with standard base64
 *
 * @param bytes - The binary data to encode (typically from crypto.getRandomValues() or crypto.subtle.digest())
 * @returns URL-safe Base64 encoded string without padding
 *
 * @example
 * ```typescript
 * const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
 * const encoded = base64urlEncode(bytes);
 * console.log(encoded); // "SGVsbG8" (no padding, URL-safe)
 * ```
 */
function base64urlEncode(bytes: Uint8Array): string {
	const base64 = btoa(String.fromCharCode(...bytes));
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
