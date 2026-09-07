import { describe, expect, it } from "bun:test";
import {
	isAnthropicOrgPermissionDenied,
	ORG_PERMISSION_DENIED_REASON,
} from "../provider";

/**
 * Body observed in production (25 occurrences) when an organization has
 * disabled OAuth for Claude Code. Captured from `GET /api/oauth/usage`, but
 * `/v1/messages` rejects the same account with the same status + error.type
 * and a differently worded, Claude-Code-specific message — which is exactly
 * why the predicate must key on `error.type`, not on the message.
 */
const OAUTH_NOT_ALLOWED_BODY = {
	type: "error",
	error: {
		type: "permission_error",
		message:
			"OAuth authentication is currently not allowed for this organization.",
		details: {
			error_visibility: "user_facing",
			error_code: "oauth_not_allowed_for_organization",
		},
	},
	request_id: "req_011CeJWapJc7LETV42WEGiAD",
};

/** The wording Claude Code surfaces to the user on `/v1/messages`. */
const SUBSCRIPTION_DISABLED_BODY = {
	type: "error",
	error: {
		type: "permission_error",
		message:
			"Your organization has disabled Claude subscription access for Claude Code. Use an Anthropic API key instead, or ask your admin to enable access.",
	},
};

function jsonResponse(
	status: number,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
	});
}

describe("isAnthropicOrgPermissionDenied", () => {
	it("the exported reason constant is 'org_permission_denied'", () => {
		expect(ORG_PERMISSION_DENIED_REASON).toBe("org_permission_denied");
	});

	it("returns true for the observed 403 oauth_not_allowed_for_organization body", async () => {
		const response = jsonResponse(403, OAUTH_NOT_ALLOWED_BODY, {
			"x-should-retry": "false",
		});

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(true);
	});

	it("returns true for the Claude-Code subscription-disabled wording (message text is not part of the match)", async () => {
		const response = jsonResponse(403, SUBSCRIPTION_DISABLED_BODY);

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(true);
	});

	it("does not require the x-should-retry header to be present", async () => {
		// The header was observed on the usage endpoint, but requiring it would
		// fail closed — back to today's broken pass-through — if Anthropic omits
		// it on /v1/messages. It must corroborate, never gate.
		const response = jsonResponse(403, OAUTH_NOT_ALLOWED_BODY);

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(true);
	});

	it("leaves the response body readable for the caller", async () => {
		const response = jsonResponse(403, OAUTH_NOT_ALLOWED_BODY);

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(true);
		expect(response.bodyUsed).toBe(false);
		const parsed = (await response.json()) as typeof OAUTH_NOT_ALLOWED_BODY;
		expect(parsed.error.type).toBe("permission_error");
	});

	describe("status is an exact gate", () => {
		for (const status of [200, 400, 401, 429, 500]) {
			it(`returns false for ${status} even with a permission_error body`, async () => {
				const response = jsonResponse(status, OAUTH_NOT_ALLOWED_BODY);

				expect(await isAnthropicOrgPermissionDenied(response)).toBe(false);
			});
		}
	});

	it("returns false for a 403 whose error.type is not permission_error", async () => {
		const response = jsonResponse(403, {
			type: "error",
			error: { type: "authentication_error", message: "invalid x-api-key" },
		});

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(false);
	});

	it("returns false for a 403 with a non-JSON content-type (e.g. a Cloudflare block page)", async () => {
		// Deliberately narrow: a non-JSON 403 can be an edge/network block that
		// would reject every account identically, and benching the pool one
		// account per attempt is the failure mode issue #301 was about. Those
		// keep the pre-existing pass-through behaviour.
		const response = new Response("<html>403 Forbidden</html>", {
			status: 403,
			headers: { "content-type": "text/html" },
		});

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(false);
	});

	it("returns false for a 403 with malformed JSON (exercises the catch block)", async () => {
		const response = new Response("{not valid json", {
			status: 403,
			headers: { "content-type": "application/json" },
		});

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(false);
	});

	it("returns false for a 403 with no error object at all", async () => {
		const response = jsonResponse(403, { message: "Forbidden" });

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(false);
	});

	it("is case-sensitive on error.type", async () => {
		const response = jsonResponse(403, {
			type: "error",
			error: { type: "Permission_Error", message: "nope" },
		});

		expect(await isAnthropicOrgPermissionDenied(response)).toBe(false);
	});
});
