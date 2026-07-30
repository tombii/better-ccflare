import { describe, expect, it } from "bun:test";
import { isAnthropicExtraUsageExhausted } from "../providers/anthropic/provider";
import { OpenAICompatibleProvider } from "../providers/openai/provider";

/**
 * Guards against orphaned `Response` body tee branches (issue #356, follow-up
 * to #354).
 *
 * `clone()` tees the body: the copy and the original are fed from one source,
 * and the tee retains whatever the consumed branch has read until the other
 * branch is read or cancelled. A branch that is neither is an orphan — it
 * keeps buffering for as long as the response object lives, and it holds the
 * underlying socket from finishing its teardown.
 *
 * The invariant asserted here is deliberately about the *observable* state
 * rather than the implementation: after the call, no body that the function
 * created or received may be left both unread and un-cancelled. `bodyUsed`
 * covers cancellation too, since cancelling disturbs the stream.
 */

/**
 * Records every clone created while `body` runs and reports the ones left with
 * an unconsumed body.
 *
 * The patch is installed around the call and removed in `finally` rather than
 * in a hook: Bun runs all test files in one process, so a patch that survived a
 * throwing assertion would leak into unrelated suites. A null-body clone is not
 * counted — it holds nothing and can never become `bodyUsed`.
 */
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
		Response.prototype.clone = original;
	}
	return clones.filter((c) => c.body !== null && !c.bodyUsed);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A body-carrying response that is deliberately NOT application/json. */
function textResponse(body: string, status = 400): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/plain" },
	});
}

describe("isAnthropicExtraUsageExhausted — no orphaned clone", () => {
	it("detects the extra-usage 400 and consumes what it read", async () => {
		const res = jsonResponse(
			{
				error: {
					type: "invalid_request_error",
					message: "Your extra usage balance is depleted",
				},
			},
			400,
		);
		expect(await isAnthropicExtraUsageExhausted(res)).toBe(true);
	});

	// The clone used to be taken BEFORE the content-type check, so a 400 that
	// is not JSON returned early and left that copy unread forever. Anthropic
	// does emit non-JSON 400s (proxy/gateway error pages), so this is reachable.
	it("leaves no orphaned clone when a 400 is not JSON", async () => {
		const res = textResponse("Bad Request", 400);
		const orphans = await orphansCreatedBy(async () => {
			expect(await isAnthropicExtraUsageExhausted(res)).toBe(false);
		});
		expect(orphans.length).toBe(0);
		// The original must still be intact for the caller.
		expect(await res.text()).toBe("Bad Request");
	});

	it("does not touch the body at all for a non-400 status", async () => {
		const res = jsonResponse({ ok: true }, 200);
		expect(await isAnthropicExtraUsageExhausted(res)).toBe(false);
		expect(res.bodyUsed).toBe(false);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe("OpenAICompatibleProvider.processResponse — no orphaned original", () => {
	const provider = new OpenAICompatibleProvider();

	// processResponse cloned the incoming response, read the CLONE, and returned
	// a freshly built Response. Callers therefore never consume the original,
	// so its branch of the tee was orphaned on EVERY openai-compatible JSON
	// response — not just on error paths.
	it("leaves no unread body behind on a converted JSON response", async () => {
		const upstream = jsonResponse({
			id: "chatcmpl-1",
			object: "chat.completion",
			model: "gpt-x",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "hi" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});

		const converted = await provider.processResponse(upstream, null);

		// The conversion result must be usable...
		expect(converted.status).toBe(200);
		await converted.text();
		// ...and the upstream response must not be left holding an unread tee
		// branch. Anything the provider cloned has to be consumed or cancelled.
		expect(upstream.bodyUsed).toBe(true);
	});

	it("passes non-JSON responses through without stranding a body", async () => {
		const upstream = new Response("plain text", {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
		const out = await provider.processResponse(upstream, null);
		// Pass-through: the same body must still be readable exactly once.
		expect(await out.text()).toBe("plain text");
	});
});
