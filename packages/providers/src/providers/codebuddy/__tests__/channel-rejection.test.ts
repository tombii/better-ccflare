import { describe, expect, it } from "bun:test";
import {
	isCodeBuddyChannelRejection,
	readCodeBuddyGatewayRejection,
} from "../provider";

function jsonResponse(body: unknown, status = 400) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("isCodeBuddyChannelRejection", () => {
	it("matches the live 11128 channel-verification rejection", () => {
		// Verbatim shape observed in production on 2026-10-29.
		return expect(
			isCodeBuddyChannelRejection(
				jsonResponse({
					code: 11128,
					msg: "Illegal API invocation from an unapproved channel",
					requestId: "b782247b6b7f414faea7a2051081b449",
				}),
			),
		).resolves.toBe(true);
	});

	it("does not match a different gateway code", async () => {
		expect(
			await isCodeBuddyChannelRejection(
				jsonResponse({ code: 11101, msg: "tool_choice must be a string" }),
			),
		).toBe(false);
	});

	it("does not match a non-400 status", async () => {
		expect(
			await isCodeBuddyChannelRejection(
				jsonResponse({ code: 11128, msg: "x" }, 500),
			),
		).toBe(false);
	});

	it("does not match a non-JSON body", async () => {
		expect(
			await isCodeBuddyChannelRejection(
				new Response("<html>gateway</html>", {
					status: 400,
					headers: { "Content-Type": "text/html" },
				}),
			),
		).toBe(false);
	});

	it("leaves the original response body readable", async () => {
		const response = jsonResponse({ code: 11128, msg: "x" });
		await isCodeBuddyChannelRejection(response);
		// The predicate clones internally; the original must stay unconsumed.
		expect(await response.text()).toContain("11128");
	});
});

describe("readCodeBuddyGatewayRejection", () => {
	it("returns the upstream message so the journal can distinguish causes", async () => {
		const rejection = await readCodeBuddyGatewayRejection(
			jsonResponse({
				code: 11128,
				msg: "Illegal API invocation from an unapproved channel",
			}),
		);
		expect(rejection).toEqual({
			code: 11128,
			msg: "Illegal API invocation from an unapproved channel",
		});
	});

	it("returns null for non-matching bodies", async () => {
		expect(
			await readCodeBuddyGatewayRejection(
				jsonResponse({ code: 11101, msg: "x" }),
			),
		).toBeNull();
	});
});
