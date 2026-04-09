// Codex device code auth flow (RFC 8628 variant)
// Matches codex-rs/login/src/device_code_auth.rs

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const USERCODE_ENDPOINT = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const TOKEN_POLL_ENDPOINT = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const TOKEN_EXCHANGE_ENDPOINT = `${AUTH_BASE}/oauth/token`;
// The redirect URI used by the device flow (not a real redirect — server-side)
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;

export interface CodexDeviceFlowResult {
	deviceAuthId: string;
	userCode: string;
	verificationUrl: string;
	interval: number;
}

export interface CodexTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

/**
 * Step 1: Request a device code from OpenAI.
 * Returns deviceAuthId + userCode for the user to enter at verificationUrl.
 */
export async function initiateCodexDeviceFlow(): Promise<CodexDeviceFlowResult> {
	const response = await fetch(USERCODE_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`Failed to initiate Codex device flow: ${response.status} ${text}`,
		);
	}

	const data = (await response.json()) as {
		device_auth_id: string;
		user_code?: string;
		usercode?: string;
		interval?: string;
	};

	const interval = data.interval ? parseInt(data.interval, 10) : 5;

	return {
		deviceAuthId: data.device_auth_id,
		userCode: data.user_code ?? data.usercode ?? "",
		verificationUrl: `${AUTH_BASE}/codex/device`,
		interval: Number.isNaN(interval) ? 5 : interval,
	};
}

/**
 * Step 2: Poll until the user completes authorization.
 * On success, exchanges the returned authorization_code for OAuth tokens.
 */
export async function pollCodexForToken(
	deviceAuthId: string,
	userCode: string,
	interval: number = 5,
	maxAttempts: number = 180, // 15 min at 5s intervals
	onTick?: (attempt: number) => void,
): Promise<CodexTokenResponse> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		onTick?.(attempt);
		await sleep(interval * 1000);

		const response = await fetch(TOKEN_POLL_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				device_auth_id: deviceAuthId,
				user_code: userCode,
			}),
		});

		if (response.ok) {
			const data = (await response.json()) as {
				authorization_code: string;
				code_challenge: string;
				code_verifier: string;
			};
			// Exchange the authorization code for tokens
			return exchangeCodexDeviceCode(
				data.authorization_code,
				data.code_verifier,
				data.code_challenge,
			);
		}

		// 403/404 = authorization_pending — keep polling
		if (response.status === 403 || response.status === 404) {
			continue;
		}

		const text = await response.text().catch(() => response.statusText);
		throw new Error(`Codex device auth failed: ${response.status} ${text}`);
	}

	throw new Error(
		"Timed out waiting for Codex authorization. The device code may have expired. Please try again.",
	);
}

/**
 * Exchange the authorization_code returned by the device poll for real OAuth tokens.
 * The PKCE verifier/challenge are provided by OpenAI in the poll response.
 */
async function exchangeCodexDeviceCode(
	authorizationCode: string,
	codeVerifier: string,
	_codeChallenge: string,
): Promise<CodexTokenResponse> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: authorizationCode,
		redirect_uri: DEVICE_REDIRECT_URI,
		client_id: CLIENT_ID,
		code_verifier: codeVerifier,
	});

	const response = await fetch(TOKEN_EXCHANGE_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Codex token exchange failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expires_in: data.expires_in,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
