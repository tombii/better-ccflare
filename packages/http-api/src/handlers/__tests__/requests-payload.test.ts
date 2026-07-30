import { describe, expect, it } from "bun:test";
import { createRequestPayloadHandler } from "../requests";

/**
 * A stored payload is optional by design: capture can be switched off, and the
 * usage collector releases payloads of requests that are still active after
 * REQUEST_PAYLOAD_RETENTION_MS to bound memory. The endpoint must therefore not
 * report a missing payload as a missing request — that reading cost real
 * debugging time when a 340 s request came back as "Request not found".
 */

function dbWithPayload(payload: unknown) {
	return { getRequestPayload: async () => payload } as never;
}

describe("createRequestPayloadHandler", () => {
	it("returns the payload when one is stored", async () => {
		const handler = createRequestPayloadHandler(
			dbWithPayload({ requestBody: "e30=" }),
		);

		const response = await handler("req-1");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ requestBody: "e30=" });
	});

	it("does not claim the request is missing when only the payload is absent", async () => {
		const handler = createRequestPayloadHandler(dbWithPayload(null));

		const response = await handler("req-2");
		const body = (await response.json()) as {
			error: string;
			detail?: string;
		};

		expect(response.status).toBe(404);
		// The old wording asserted something the endpoint cannot know.
		expect(body.error).not.toBe("Request not found");
		expect(body.error.toLowerCase()).toContain("payload");
		// And it explains why a payload can legitimately be absent.
		expect(body.detail).toBeDefined();
	});

	it("answers with JSON content type in the absent case", async () => {
		const handler = createRequestPayloadHandler(dbWithPayload(null));

		const response = await handler("req-3");

		expect(response.headers.get("Content-Type")).toBe("application/json");
	});
});
