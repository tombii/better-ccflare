import { describe, expect, it } from "bun:test";
import {
	createPoolExhaustedResponse,
	VISION_UNSUPPORTED_MESSAGE,
} from "../proxy-operations";

/**
 * Every eligible route rejecting the request's image input is NOT an exhausted
 * pool: no account is benched, nothing is cooling down, and retrying the same
 * request fails identically forever. Answering `pool_exhausted` (503 +
 * Retry-After) told clients and body-reading consumers to wait for a recovery
 * that never comes, and made "my images stopped working" look like an outage.
 */
describe("createPoolExhaustedResponse — vision_unsupported", () => {
	it("answers 400, not the transient 503", async () => {
		const res = createPoolExhaustedResponse(
			[],
			undefined,
			"vision_unsupported",
		);
		expect(res.status).toBe(400);
	});

	it("carries no Retry-After and no next_available_at", async () => {
		const res = createPoolExhaustedResponse(
			[],
			undefined,
			"vision_unsupported",
		);
		expect(res.headers.get("Retry-After")).toBeNull();

		const body = (await res.json()) as {
			error: { next_available_at: unknown; message: string };
		};
		expect(body.error.next_available_at).toBeNull();
	});

	it("names the cause in error.type, message and the pool-status header", async () => {
		const res = createPoolExhaustedResponse(
			[],
			undefined,
			"vision_unsupported",
		);
		const body = (await res.json()) as {
			error: { type: string; message: string; accounts: unknown[] };
		};
		expect(body.error.type).toBe("vision_unsupported");
		expect(body.error.message).toBe(VISION_UNSUPPORTED_MESSAGE);
		expect(res.headers.get("x-better-ccflare-pool-status")).toBe(
			"vision_unsupported",
		);
	});

	it("leaves the other kinds on the 503 transient shape", async () => {
		for (const kind of ["pool_exhausted", "circuit_open"] as const) {
			const res = createPoolExhaustedResponse([], undefined, kind);
			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).not.toBeNull();
			expect(res.headers.get("x-better-ccflare-pool-status")).toBe("exhausted");
			const body = (await res.json()) as { error: { type: string } };
			expect(body.error.type).toBe(kind);
		}
	});
});
