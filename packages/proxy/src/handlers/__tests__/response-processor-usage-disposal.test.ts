import { describe, expect, it, mock } from "bun:test";
import type { Provider } from "@better-ccflare/providers";
import {
	updateAccountMetadata,
	withDisposableCopy,
} from "../response-processor";
import {
	isOrphaned,
	makeAccount,
	makeProxyContext,
	recordClonesDuring,
	waitForCloneBodiesToSettle,
} from "./clone-leak-harness";

/**
 * S8 & S9 (spec TEST-SPEC.md §4) — `updateAccountMetadata` driven directly.
 *
 * `updateAccountMetadata` uses `ctx.provider` directly (unlike
 * `proxyWithAccount`, which resolves the registry-registered provider first),
 * so a plain stub binds here and is the honest unit for exercising both
 * `withDisposableCopy` call sites (the `parseUsage` streaming branch and the
 * `extractUsageInfo` branch) without needing the real Bedrock/Anthropic
 * implementations.
 */
describe("updateAccountMetadata — usage-extraction clone disposal", () => {
	it("S8 (red-without-fix): a throwing extractUsageInfo reader still disposes of its clone", async () => {
		const account = makeAccount({ provider: "openai-compatible" }); // not "codex"
		const stubProvider = {
			name: "stub",
			canHandle: () => true,
			buildUrl: () => "https://example.test",
			prepareHeaders: () => new Headers(),
			processResponse: async (r: Response) => r,
			refreshToken: async () => {
				throw new Error("not used");
			},
			parseRateLimit: () => ({ isRateLimited: false }),
			isStreamingResponse: () => false,
			extractUsageInfo: async () => {
				throw new Error("usage boom");
			},
		} as unknown as Provider;
		const ctx = makeProxyContext({ provider: stubProvider });

		const response = new Response('{"id":"msg_1","usage":{}}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		let unhandledRejection: unknown;
		const onUnhandled = (reason: unknown) => {
			unhandledRejection = reason;
		};
		process.on("unhandledRejection", onUnhandled);

		const clones = await recordClonesDuring(async () => {
			updateAccountMetadata(account, response, ctx, "req-1");
			// updateAccountMetadata is synchronous; the usage extraction runs in
			// a fire-and-forget IIFE. Give it a chance to run, throw, and settle
			// before the prototype patch is removed.
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		});

		process.off("unhandledRejection", onUnhandled);

		expect(unhandledRejection).toBeUndefined();
		await waitForCloneBodiesToSettle(clones);
		expect(clones.length).toBeGreaterThanOrEqual(1);
		expect(clones.every((c) => c.bodyUsed)).toBe(true); // disposed via the finally cancel (P2)
		expect(clones.filter(isOrphaned).length).toBe(0);
	});

	it("S9 (red-without-fix): the streaming parseUsage branch disposes of its clone even when the reader ignores it", async () => {
		const account = makeAccount({ provider: "openai-compatible" });
		const parseUsage = mock(async (_copy: Response) => null);
		const stubProvider = {
			name: "stub-stream",
			canHandle: () => true,
			buildUrl: () => "https://example.test",
			prepareHeaders: () => new Headers(),
			processResponse: async (r: Response) => r,
			refreshToken: async () => {
				throw new Error("not used");
			},
			parseRateLimit: () => ({ isRateLimited: false }),
			isStreamingResponse: () => true,
			parseUsage,
		} as unknown as Provider;
		const ctx = makeProxyContext({ provider: stubProvider });

		const response = new Response("event: message_start\ndata: {}\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const clones = await recordClonesDuring(async () => {
			updateAccountMetadata(account, response, ctx, "req-1");
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		});

		await waitForCloneBodiesToSettle(clones);

		expect(parseUsage).toHaveBeenCalledTimes(1);
		expect(clones.length).toBeGreaterThanOrEqual(1);
		expect(clones.every((c) => c.bodyUsed)).toBe(true);
		expect(clones.filter(isOrphaned).length).toBe(0);
	});
});

/**
 * S10 (spec TEST-SPEC.md §4) — `withDisposableCopy` contract tests, driven
 * directly. PINS: the helper is new code introduced by the fix; on the
 * pre-fix tree the import itself fails to resolve (a build-red, not an
 * invariant-red) — see IMPL-REPORT.md.
 */
describe("withDisposableCopy — contract", () => {
	it("(a) reader consumes: resolves the read value, copy settles, source stays readable", async () => {
		const response = new Response("payload-123");

		const clones = await recordClonesDuring(async () => {
			const result = await withDisposableCopy(response, (c) => c.text());
			expect(result).toBe("payload-123");
		});

		expect(clones.length).toBe(1);
		expect(clones[0].bodyUsed).toBe(true);
		await expect(response.text()).resolves.toBe("payload-123");
	});

	it("(b) reader ignores the copy: helper cancels it, resolves the read value, source stays readable", async () => {
		const response = new Response("payload-123");

		const clones = await recordClonesDuring(async () => {
			const result = await withDisposableCopy(response, async () => 42);
			expect(result).toBe(42);
		});

		expect(clones.length).toBe(1);
		expect(clones[0].bodyUsed).toBe(true); // cancelled by the finally block (P2)
		await expect(response.text()).resolves.toBe("payload-123");
	});

	it("(c) reader throws: rejection propagates and the clone still settles via the finally cancel", async () => {
		const response = new Response("payload-123");
		const original = Response.prototype.clone;
		let captured: Response | undefined;
		Response.prototype.clone = function tracked(this: Response) {
			const copy = original.call(this);
			captured = copy;
			return copy;
		};

		let caught: unknown;
		try {
			await withDisposableCopy(response, async () => {
				throw new Error("boom");
			});
		} catch (e) {
			caught = e;
		} finally {
			Response.prototype.clone = original;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(captured).toBeDefined();
		expect(captured?.bodyUsed).toBe(true); // finally ran before the rejection propagated
	});

	it("(d) body already locked by the reader: helper skips the cancel, branch stays locked, no throw escapes", async () => {
		const response = new Response("payload-123");

		let captured: Response | undefined;
		const original = Response.prototype.clone;
		Response.prototype.clone = function tracked(this: Response) {
			const copy = original.call(this);
			captured = copy;
			return copy;
		};

		let result: unknown;
		let threw = false;
		try {
			result = await withDisposableCopy(response, async (c) => {
				c.body?.getReader();
				return "locked";
			});
		} catch {
			threw = true;
		} finally {
			Response.prototype.clone = original;
		}

		expect(threw).toBe(false);
		expect(result).toBe("locked");
		// Bun marks bodyUsed=true on getReader() alone (P3), so the helper's
		// `!copy.bodyUsed` guard is false and it skips the cancel — the branch
		// stays locked. This pins a documented limitation of the helper: a
		// lock-and-abandon reader defeats disposal (the inner catch in
		// withDisposableCopy's finally is defensive and, on this Bun version,
		// unreachable via getReader alone).
		expect(captured?.body?.locked).toBe(true);
	});

	it("(e) null body: resolves the read value without throwing, copy has a null body", async () => {
		const response = new Response(null);

		const clones = await recordClonesDuring(async () => {
			const result = await withDisposableCopy(response, async () => "x");
			expect(result).toBe("x");
		});

		expect(clones.length).toBe(1);
		expect(clones[0].body).toBeNull();
	});
});
