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

		// For server context, return a dummy waitForCode that should not be called
		return {
			uri,
			pkceChallenge: "", // Not used in server context
			state: "", // Not used in server context
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

	// Generate secure random state for CSRF protection
	const generateState = (): string => {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
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
						// Validate state parameter to prevent CSRF attacks
						if (state !== expectedState) {
							return new Response(
								"Invalid state parameter - possible CSRF attack",
								{
									status: 400,
								},
							);
						}

						// State validated, resolve the promise with authorization code
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
				server.stop();
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
				server.stop();
			}
		},
		cleanup: () => {
			server.stop();
		},
	};
}
