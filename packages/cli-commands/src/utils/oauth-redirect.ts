import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { OAuthFlow } from "@better-ccflare/oauth-flow";
import { generatePKCE } from "@better-ccflare/providers";

/**
 * Result interface for OAuth redirect URI creation
 *
 * @interface RedirectUriResult
 */
interface RedirectUriResult {
	/** The complete OAuth authorization URL */
	uri: string;
	/** PKCE challenge to be sent to the OAuth provider */
	pkceChallenge: string;
	/** CSRF state parameter with embedded timestamp for replay protection */
	state: string;
	/** Promise that resolves with authorization code and PKCE verifier when OAuth completes */
	waitForCode: () => Promise<{ code: string; pkceVerifier: string }>;
	/** Cleanup function for temporary server (CLI context only) */
	cleanup?: () => void;
}

/**
 * Creates a context-aware redirect URI for OAuth flows with enhanced security
 *
 * This function handles OAuth authorization in two different contexts:
 * - **Server Context**: Uses existing server port for web-based OAuth flows
 * - **CLI Context**: Creates temporary HTTP server to handle OAuth callback from command line
 *
 * **Security Features:**
 * - PKCE (Proof Key for Code Exchange) for authorization code exchange security
 * - CSRF protection with cryptographically secure random state
 * - Timestamp validation to prevent replay attacks (5-minute window)
 * - Base64url encoding for safe URL transmission of state
 *
 * **Server vs CLI Context Distinction:**
 * - Server context: Used when the application is already running as a web server
 * - CLI context: Used when OAuth is initiated from command line tools
 *
 * @param dbOps - Database operations interface (currently unused but reserved for future use)
 * @param config - Configuration object containing runtime settings
 * @param oauthFlow - OAuth flow configuration details
 * @param isServerContext - Whether this is running in server context (true) or CLI context (false)
 * @param customPort - Optional custom port for server context OAuth callback
 * @returns Promise resolving to redirect URI result with PKCE and security parameters
 *
 * @example
 * ```typescript
 * // CLI context usage
 * const result = await createOAuthRedirectUri(dbOps, config, oauthFlow, false);
 * console.log(result.uri); // OAuth authorization URL to open in browser
 * const { code, pkceVerifier } = await result.waitForCode(); // Wait for user completion
 *
 * // Server context usage
 * const result = await createOAuthRedirectUri(dbOps, config, oauthFlow, true, 8080);
 * console.log(result.uri); // OAuth URL using existing server
 * ```
 */
export async function createOAuthRedirectUri(
	dbOps: DatabaseOperations,
	config: Config,
	oauthFlow: OAuthFlow,
	isServerContext: boolean = false,
	customPort?: number,
): Promise<RedirectUriResult> {
	if (isServerContext && customPort) {
		// Server context: use existing server port
		const protocol =
			process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH ? "https" : "http";
		const port = customPort;
		const uri = `${protocol}://localhost:${port}/callback`;

		// Generate PKCE challenge for server context (still needed for security)
		const pkce = await generatePKCE();
		const pkceChallenge = pkce.challenge;

		// Generate secure random state for CSRF protection with timestamp in server context
		const generateState = (): string => {
			const array = new Uint8Array(32);
			crypto.getRandomValues(array);
			const csrfToken = Array.from(array, (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");

			// Create state with timestamp for replay attack protection
			const state: OAuthState = {
				csrfToken,
				timestamp: Date.now(),
			};

			// Encode as base64url for safe URL transmission
			return btoa(JSON.stringify(state))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=/g, "");
		};
		const state = generateState();

		// For server context, return a dummy waitForCode that should not be called
		return {
			uri,
			pkceChallenge, // PKCE challenge for OAuth URL
			state, // CSRF state for OAuth URL
			waitForCode: () => {
				throw new Error("waitForCode should not be called in server context");
			},
		};
	} else {
		// CLI context: create temporary server
		return await createTemporaryOAuthServer(dbOps, config, oauthFlow);
	}
}

/**
 * OAuth state interface for enhanced security against replay attacks
 *
 * This interface defines the structure of the OAuth state parameter that is
 * sent to the OAuth provider and returned in the callback. It provides both
 * CSRF protection and replay attack prevention through timestamp validation.
 *
 * @interface OAuthState
 */
interface OAuthState {
	/** Cryptographically secure random token for CSRF protection (64-character hex string) */
	csrfToken: string;
	/** Unix timestamp in milliseconds for replay attack prevention */
	timestamp: number;
}

/**
 * Validates OAuth state timestamp to prevent replay attacks
 *
 * **Security Assumptions:**
 * - Valid timestamps must be within the last 5 minutes (300,000ms)
 * - Future timestamps are rejected to prevent time manipulation attacks
 * - This provides a balance between security and user experience
 *
 * @param timestamp - The timestamp from the OAuth state parameter (Unix milliseconds)
 * @returns true if timestamp is valid and within acceptable time window, false otherwise
 *
 * @example
 * ```typescript
 * const now = Date.now();
 * const validTimestamp = now - 60000; // 1 minute ago
 * const invalidTimestamp = now - 400000; // 6.6 minutes ago
 *
 * isValidTimestamp(validTimestamp); // true
 * isValidTimestamp(invalidTimestamp); // false
 * ```
 */
const isValidTimestamp = (timestamp: number): boolean => {
	const now = Date.now();
	const age = now - timestamp;
	const maxAge = 5 * 60 * 1000; // 5 minutes in milliseconds
	return age < maxAge && age >= 0; // Not too old and not from the future
};

/**
 * Parses and validates OAuth state parameter from OAuth callback
 *
 * **Security Validation:**
 * - Validates base64url encoding format
 * - Ensures proper JSON structure
 * - Validates CSRF token format (must be string)
 * - Validates timestamp format and range (must be number and valid)
 * - Calls isValidTimestamp() for replay attack prevention
 *
 * **Encoding Details:**
 * - State is base64url encoded for safe URL transmission
 * - Uses URL-safe base64 variant (replaces + with -, / with _)
 * - Handles padding restoration for proper base64 decoding
 *
 * **Error Handling:**
 * - Returns null for any parsing or validation errors
 * - Catches JSON parsing exceptions and base64 decoding errors
 * - Treats any malformed input as potential attack vector
 *
 * @param state - The base64url encoded state parameter from OAuth callback URL
 * @returns Parsed and validated OAuthState object, or null if any validation fails
 *
 * @example
 * ```typescript
 * const validState = "eyJjc3JmVG9rZW4iOiJhYmNkZWYiLCJ0aW1lc3RhbXAiOjE2MDk0NTkyMDAwMH0";
 * const parsed = parseOAuthState(validState);
 * console.log(parsed?.csrfToken); // "abcdef" (if valid)
 *
 * const invalidState = "invalid-state";
 * const parsed2 = parseOAuthState(invalidState);
 * console.log(parsed2); // null
 * ```
 */
const parseOAuthState = (state: string): OAuthState | null => {
	try {
		// Decode base64url state
		const base64State = state.replace(/-/g, "+").replace(/_/g, "/");
		const jsonState = atob(base64State + "=".repeat((4 - (base64State.length % 4)) % 4));
		const parsedState: OAuthState = JSON.parse(jsonState);

		// Validate structure
		if (
			!parsedState ||
			typeof parsedState.csrfToken !== "string" ||
			typeof parsedState.timestamp !== "number"
		) {
			return null;
		}

		// Validate timestamp
		if (!isValidTimestamp(parsedState.timestamp)) {
			return null;
		}

		return parsedState;
	} catch (error) {
		// Any parsing error means invalid state
		return null;
	}
};

/**
 * Creates a temporary HTTP server for CLI OAuth flows
 * The server handles the OAuth callback and captures the authorization code
 */
async function createTemporaryOAuthServer(
	_dbOps: DatabaseOperations,
	_config: Config,
	_oauthFlow: OAuthFlow,
): Promise<RedirectUriResult> {
	// Generate PKCE challenge and store verifier in server memory (never in URLs!)
	const pkce = await generatePKCE();
	const pkceVerifier = pkce.verifier;
	const pkceChallenge = pkce.challenge;

	// Generate secure random state for CSRF protection with timestamp
	const generateState = (): string => {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		const csrfToken = Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");

		// Create state with timestamp for replay attack protection
		const state: OAuthState = {
			csrfToken,
			timestamp: Date.now(),
		};

		// Encode as base64url for safe URL transmission
		return btoa(JSON.stringify(state))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=/g, "");
	};

	// Generate and store expected state for CSRF validation
	const expectedState = generateState();

	// Create a promise that will resolve when we receive the OAuth callback
	let resolveCallback:
		| ((result: { code: string; pkceVerifier: string }) => void)
		| null = null;
	let rejectCallback: ((error: Error) => void) | null = null;

	const callbackPromise = new Promise<{ code: string; pkceVerifier: string }>(
		(resolve, reject) => {
			resolveCallback = resolve;
			rejectCallback = reject;
		},
	);

	// Create a timeout promise to prevent hanging indefinitely
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(
			() => {
				reject(
					new Error(
						"OAuth callback timeout: Authorization code not received within 5 minutes",
					),
				);
			},
			5 * 60 * 1000,
		); // 5 minutes timeout
	});

	// Track if server has been stopped to prevent multiple stops
	let serverStopped = false;

	// Create a safe stop function that ensures server is only stopped once
	const safeStopServer = () => {
		if (!serverStopped) {
			server.stop();
			serverStopped = true;
		}
	};

	// Create a temporary server using Bun.serve
	const server = await Bun.serve({
		port: 0, // Let the OS choose an available port
		fetch: async (request) => {
			try {
				// Handle the OAuth callback request
				if (request.method === "GET") {
					const url = new URL(request.url);

					// Extract code and state from query parameters
					const code = url.searchParams.get("code");
					const state = url.searchParams.get("state");

					if (code && pkceVerifier && state) {
						// Parse and validate received state
						const receivedState = parseOAuthState(state);
						const expectedParsedState = parseOAuthState(expectedState);

						if (!receivedState || !expectedParsedState) {
							return new Response(
								"Invalid state parameter format - possible CSRF attack",
								{
									status: 400,
								},
							);
						}

						// Validate CSRF token
						if (receivedState.csrfToken !== expectedParsedState.csrfToken) {
							return new Response(
								"Invalid CSRF token - possible CSRF attack",
								{
									status: 400,
								},
							);
						}

						// State and CSRF token validated, resolve the promise with authorization code
						if (resolveCallback) {
							resolveCallback({
								code,
								pkceVerifier: pkceVerifier,
							});
						}

						// Return a success HTML page for the user
						const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 2rem; }
    .success { color: #16a34a; font-size: 1.5rem; margin: 1rem 0; }
    .info { color: #6b7280; margin: 0.5rem 0; }
    .close { margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>✅ Authentication Successful</h1>
  <div class="success">Authorization code received!</div>
  <div class="info">You can now close this window and return to the application.</div>
  <div class="close">
    <button onclick="window.close()">Close Window</button>
  </div>
  <script>
    // Auto-close after 3 seconds
    setTimeout(() => window.close(), 3000);
  </script>
</body>
</html>`;

						return new Response(html, {
							headers: { "Content-Type": "text/html" },
						});
					} else {
						// If we don't have the code and state, return an error
						return new Response(
							"Bad Request: Missing code or state parameters",
							{
								status: 400,
							},
						);
					}
				} else {
					// For non-GET requests, return a 405 Method Not Allowed
					return new Response("Method Not Allowed", { status: 405 });
				}
			} catch (error) {
				console.error("Error in temporary OAuth server:", error);
				if (rejectCallback) {
					rejectCallback(
						error instanceof Error ? error : new Error(String(error)),
					);
				}
				// Clean up server on error to prevent resource leaks
				safeStopServer();
				return new Response("Internal Server Error", { status: 500 });
			}
		},
	});

	// Wait a brief moment for the server to start
	await new Promise((resolve) => setTimeout(resolve, 100));

	const protocol = "http"; // Temporary server is HTTP only
	const uri = `${protocol}://localhost:${server.port}/callback`;

	// Return the URI, PKCE challenge, state, and functions for code handling
	return {
		uri,
		pkceChallenge,
		state: expectedState,
		waitForCode: async () => {
			try {
				// Wait for either the callback or the timeout
				return await Promise.race([callbackPromise, timeoutPromise]);
			} finally {
				// Always clean up the server after receiving the code or timeout
				safeStopServer();
			}
		},
		cleanup: () => {
			safeStopServer();
		},
	};
}
