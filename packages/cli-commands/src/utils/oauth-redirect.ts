import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { OAuthFlow } from "@better-ccflare/oauth-flow";
import { generatePKCE } from "@better-ccflare/providers";

interface RedirectUriResult {
	uri: string;
	pkceChallenge: string; // PKCE challenge for OAuth URL
	state: string; // CSRF state for OAuth URL
	waitForCode: () => Promise<{ code: string; pkceVerifier: string }>;
	cleanup?: () => void; // Function to clean up temporary server if created
}

/**
 * Creates a context-aware redirect URI for OAuth flows
 * - In server context: uses existing server port
 * - In CLI context: creates temporary server and returns its URL
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
 * OAuth state interface for enhanced security
 */
interface OAuthState {
	csrfToken: string;
	timestamp: number;
}

/**
 * Validate timestamp to prevent replay attacks
 * @param timestamp - The timestamp from the OAuth state
 * @returns true if timestamp is valid (within 5 minutes), false otherwise
 */
const isValidTimestamp = (timestamp: number): boolean => {
	const now = Date.now();
	const age = now - timestamp;
	const maxAge = 5 * 60 * 1000; // 5 minutes in milliseconds
	return age < maxAge && age >= 0; // Not too old and not from the future
};

/**
 * Parse and validate OAuth state parameter
 * @param state - The state parameter from OAuth callback
 * @returns parsed OAuthState object or null if invalid
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
