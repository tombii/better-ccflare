import { describe, expect, it } from "bun:test";
import { isModelUnavailableError } from "../proxy-operations";

/**
 * Guards the body-inspecting error classifiers against orphaned tee branches
 * (issue #356, follow-up to #354).
 *
 * These helpers clone the response to look at its JSON body. The clone used to
 * be taken BEFORE the content-type gate, so every non-JSON body returned early
 * and left that copy unread — and an unread tee branch keeps buffering for
 * whoever consumes the original. Non-JSON error bodies are ordinary here
 * (upstream gateway pages, providers such as Qwen), so the path is reachable in
 * normal operation rather than an exotic edge case.
 *
 * Only `isModelUnavailableError` is exported; its two siblings in
 * proxy-operations.ts (`isInvalidThinkingSignatureError`,
 * `isCacheControlRejectionError`) are module-private and share the identical
 * shape, so they are covered by the same change but not directly reachable
 * from a test.
 */

function textResponse(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/plain" },
	});
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Records clones made during `body`, returning those left unread. */
async function orphansCreatedBy(
	body: () => Promise<void>,
): Promise<Response[]> {
	const clones: Response[] = [];
	const original = Response.prototype.clone;
	Response.prototype.clone = function trackedClone(this: Response) {
		const copy = original.call(this);
		clones.push(copy);
		return copy;
	};
	try {
		await body();
	} finally {
		// Restored in finally, not in a hook: Bun runs every test file in one
		// process, so a patch surviving a failed assertion would leak.
		Response.prototype.clone = original;
	}
	return clones.filter((c) => c.body !== null && !c.bodyUsed);
}

describe("isModelUnavailableError — clone disposal", () => {
	it("leaves no orphaned clone when a 400 body is not JSON", async () => {
		const res = textResponse("upstream error page", 400);
		const orphans = await orphansCreatedBy(async () => {
			expect(await isModelUnavailableError(res)).toBe(false);
		});
		expect(orphans.length).toBe(0);
		// The original must remain intact for the caller.
		expect(await res.text()).toBe("upstream error page");
	});

	// A 429 returns true above the content-type gate. Pinned so that early
	// return is not "tidied" down into the try block, which would start
	// cloning bodies this path never needs to read.
	it("short-circuits a 429 without cloning at all", async () => {
		const res = textResponse("rate limited", 429);
		const orphans = await orphansCreatedBy(async () => {
			expect(await isModelUnavailableError(res)).toBe(true);
		});
		expect(orphans.length).toBe(0);
		expect(res.bodyUsed).toBe(false);
	});

	it("ignores statuses it does not classify, untouched", async () => {
		const res = jsonResponse({ ok: true }, 200);
		expect(await isModelUnavailableError(res)).toBe(false);
		expect(res.bodyUsed).toBe(false);
	});

	it("still detects the JSON model-not-found shapes", async () => {
		expect(
			await isModelUnavailableError(
				jsonResponse({ error: { type: "not_found_error" } }, 404),
			),
		).toBe(true);
		expect(
			await isModelUnavailableError(
				jsonResponse({ error: { code: "model_not_found" } }, 400),
			),
		).toBe(true);
		expect(
			await isModelUnavailableError(
				jsonResponse({ error: { message: "The model does not exist" } }, 404),
			),
		).toBe(true);
	});
});
