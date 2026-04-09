import { generatePKCE } from "../../oauth/pkce";
import type { PKCEChallenge } from "../../types";

// Qwen OAuth constants (verified against qwen-code repo)
const DEVICE_CODE_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";
const CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const SCOPE = "openid profile email model.completion";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceFlowResult {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
	pkce: PKCEChallenge;
}

export interface QwenTokenResponse {
	access_token: string;
	refresh_token: string;
	token_type: string;
	resource_url: string;
	expires_in: number;
}

/**
 * Initiate OAuth 2.0 Device Authorization Grant flow with PKCE.
 *
 * RFC 8628: The client requests a device code, then polls the token endpoint
 * while the user authorizes on a separate device/browser.
 */
export async function initiateDeviceFlow(): Promise<DeviceFlowResult> {
	const pkce = await generatePKCE();

	const body = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: SCOPE,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
	});

	const response = await fetch(DEVICE_CODE_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(
			`Failed to initiate device flow: ${response.status} ${error}`,
		);
	}

	const data = (await response.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		verification_uri_complete: string;
		expires_in: number;
		interval: number;
	};

	return {
		deviceCode: data.device_code,
		userCode: data.user_code,
		verificationUri: data.verification_uri,
		verificationUriComplete: data.verification_uri_complete,
		expiresIn: data.expires_in,
		interval: data.interval || 5,
		pkce,
	};
}

/**
 * Poll the token endpoint until the user completes authorization.
 *
 * Handles RFC 8628 error responses:
 * - authorization_pending: user hasn't authorized yet, keep polling
 * - slow_down: increase polling interval
 * - expired_token: device code expired
 * - access_denied: user denied authorization
 */
export async function pollForToken(
	deviceCode: string,
	pkce: PKCEChallenge,
	interval: number = 5,
	maxAttempts: number = 60,
	onTick?: (attempt: number) => void,
): Promise<QwenTokenResponse> {
	let currentInterval = interval;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		onTick?.(attempt);

		await sleep(currentInterval * 1000);

		const body = new URLSearchParams({
			grant_type: DEVICE_CODE_GRANT_TYPE,
			client_id: CLIENT_ID,
			device_code: deviceCode,
			code_verifier: pkce.verifier,
		});

		const response = await fetch(TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (response.ok) {
			return (await response.json()) as QwenTokenResponse;
		}

		const data = (await response.json().catch(() => ({}))) as {
			error?: string;
			error_description?: string;
		};

		switch (data.error) {
			case "authorization_pending":
				// User hasn't completed authorization yet — keep polling
				break;
			case "slow_down":
				// Server is rate-limiting our polls — increase interval
				currentInterval = Math.min(currentInterval * 1.5, 10);
				break;
			case "expired_token":
				throw new Error(
					"Device code expired. Please restart the authentication flow.",
				);
			case "access_denied":
				throw new Error(
					"Authorization was denied. Please try again with a different account.",
				);
			default:
				throw new Error(
					`Token polling failed: ${data.error || "unknown error"} — ${data.error_description || response.statusText}`,
				);
		}
	}

	throw new Error(
		"Timed out waiting for authorization. The device code may have expired. Please try again.",
	);
}

/**
 * Refresh Qwen OAuth tokens using a refresh token.
 */
export async function refreshQwenTokens(
	refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: CLIENT_ID,
		refresh_token: refreshToken,
	});

	const response = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Token refresh failed: ${response.status} ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		resource_url?: string;
	};

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token || refreshToken,
		expiresIn: data.expires_in,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
