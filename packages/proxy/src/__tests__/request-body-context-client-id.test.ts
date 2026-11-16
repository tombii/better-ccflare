import { describe, expect, it } from "bun:test";
import { RequestBodyContext } from "../request-body-context";

const encoder = new TextEncoder();

function contextWithUserId(userId: string): RequestBodyContext {
	const bytes = encoder.encode(
		JSON.stringify({ model: "claude-sonnet", metadata: { user_id: userId } }),
	);
	return new RequestBodyContext(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
	);
}

describe("RequestBodyContext.getClientId", () => {
	it("returns the session_id of a JSON-encoded user_id, as Claude Code sends it", () => {
		const userId = JSON.stringify({
			device_id: "d0",
			account_uuid: "a0",
			session_id: "0b6c1f7e-4d1a-4f2b-9c3e-5a6b7c8d9e0f",
		});
		expect(contextWithUserId(userId).getClientId()).toBe(
			"0b6c1f7e-4d1a-4f2b-9c3e-5a6b7c8d9e0f",
		);
	});

	it("returns a user_id that is not JSON as sent", () => {
		expect(contextWithUserId("client-42").getClientId()).toBe("client-42");
	});
});
