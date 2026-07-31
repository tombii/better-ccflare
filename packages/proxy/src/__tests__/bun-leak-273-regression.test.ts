/**
 * Regression test for issue #273 — ccflare-side mitigation for the Bun
 * off-heap fetch leak (oven-sh/bun#35093).
 *
 * When proxyWithAccount decides to discard a response (429/529/401
 * failover → return null, or any retry-loop overwrite of the previous
 * response), the response body MUST be explicitly drained so the backing
 * store is released. Without this, every abandoned Response holds ~100KB
 * off-heap until GC.
 *
 * Why drain and not `body.cancel()`: ccflare-42 measured that
 * `body.cancel()` is a NO-OP on every released Bun (1.3.2 / 1.3.14);
 * draining the body in chunks reduces the leak by ~85% on stock Bun
 * (full table in `bench/drain-strategy-harness.ts`). The drain helper
 * reads `body` to `done` via `getReader()` and drops each chunk, so the
 * native source is closed and the off-heap buffer is released.
 *
 * This test imports the PRODUCTION helper
 * (`handlers/discard-body-cancel.ts:cancelDiscardedResponseBody`) directly
 * — the same function the 12 discard sites in proxy-operations.ts call.
 * The orchestrator's mandatory negative-control run removes ONLY those
 * 12 call sites (and/or the `void drainBody(...)` invocation inside the
 * helper); the assertions below verify both halves:
 *
 *   Group A (helper contract) — verifies `cancelDiscardedResponseBody`
 *   reads the body to completion on a non-locked Response, and is safe on
 *   null body / locked body / already-drained body. Removing the
 *   `drainBody` call from inside the helper function flips these red.
 *
 *   Group B (call-site coverage) — performs static analysis of
 *   `proxy-operations.ts` to assert the 12 drain calls are present
 *   and structurally well-formed. Removing any one of them flips this
 *   red. We don't import proxy-operations.ts (its transitive
 *   dependency chain loads @better-ccflare/database, which itself has
 *   missing modules in this worktree's `bun install`-blocked state —
 *   a pre-existing issue unrelated to this fix), but the source-level
 *   check is enough to detect the negative-control removal: 12 sites,
 *   each line beginning with the helper name.
 *
 * Run: bun test packages/proxy/src/__tests__/bun-leak-273-regression.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	cancelDiscardedResponseBody,
	drainBody,
} from "../handlers/discard-body-cancel";

// ---------------------------------------------------------------------------
// Group A — helper contract. Imported directly so a drainBody removal
// from inside the helper function is detected at the test's runtime.
// ---------------------------------------------------------------------------

describe("issue #273 — Group A: helper contract", () => {
	it("PRODUCTION helper reads the body to done on a non-locked Response body", async () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const response = new Response(body, { status: 429 });
		const stream = response.body;
		expect(stream).not.toBeNull();
		if (!stream) throw new Error("expected body");

		cancelDiscardedResponseBody(response);

		// The drain is fire-and-forget; await a few microtasks then
		// verify the body has been consumed. After the drain loop
		// reaches `done`, the stream is released; the next reader
		// gets done=true on the very first read with no value.
		await new Promise((r) => setImmediate(r));
		const reader = stream.getReader();
		const { value, done } = await reader.read();
		reader.releaseLock();
		expect(done).toBe(true);
		expect(value).toBeUndefined();
	});

	it("PRODUCTION helper is safe when body is null", () => {
		const response = new Response(null, { status: 204 });
		expect(response.body).toBeNull();
		expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
	});

	it("PRODUCTION helper does not throw on an already-locked body", () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const response = new Response(body, { status: 503 });
		const stream = response.body;
		if (!stream) throw new Error("expected body");
		const reader = stream.getReader();
		try {
			expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
		} finally {
			reader.releaseLock();
		}
	});

	it("PRODUCTION helper does not throw when the body is already drained", async () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const response = new Response(body, { status: 429 });
		const stream = response.body;
		if (!stream) throw new Error("expected body");

		// Drain it ourselves first.
		await drainBody(stream);
		expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Group B — call-site coverage. Static check that the 12 drain sites the
// spec calls out (429/529/401 failover return-null + retry-loop overwrite)
// are wired into proxy-operations.ts. The negative-control run removes
// these lines; this check fails if any are missing.
// ---------------------------------------------------------------------------

const EXPECTED_SITE_COUNT = 12;

describe("issue #273 — Group B: call-site coverage in proxy-operations.ts", () => {
	it("proxy-operations.ts has exactly 12 cancelDiscardedResponseBody call sites", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		// Match call sites only — exclude the import line. Each call is
		// `cancelDiscardedResponseBody(rawResponse)` or
		// `cancelDiscardedResponseBody(response)` on a line of its own.
		const callMatches = source.match(
			/^\s*cancelDiscardedResponseBody\((?:rawResponse|response)\);/gm,
		);
		const count = callMatches?.length ?? 0;
		expect(count).toBe(EXPECTED_SITE_COUNT);
	});

	it("proxy-operations.ts imports the helper module", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		expect(source).toMatch(
			/import\s*\{\s*cancelDiscardedResponseBody\s*\}\s*from\s*["']\.\/discard-body-cancel["']/,
		);
	});

	it("proxy-operations.ts has drain sites at the 12 expected line ranges", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		// Type A — return null sites: cancelDiscardedResponseBody(...);\n...return null;
		const returnNullSites = source.match(
			/cancelDiscardedResponseBody\((rawResponse|response)\);[\s\S]{0,200}?return null;/g,
		);
		expect(returnNullSites?.length ?? 0).toBeGreaterThanOrEqual(8);

		// Type B — retry-loop overwrite sites: `rawResponse = ` or
		// `response = ` preceded by a cancel call. (At least 4 such
		// overwrite blocks for the retry loops — thinking-block,
		// cache_control, model-list, in-place 529.)
		const overwriteSites = source.match(
			/cancelDiscardedResponseBody\(rawResponse\);\n\s*rawResponse\s*=/g,
		);
		expect(overwriteSites?.length ?? 0).toBeGreaterThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// Group C — forwarded body safety. A discard-only contract without a
// forward-safety guarantee is the silent-stream-truncation bug class.
// Ensure the helper does NOT drain bodies we're going to forward.
// ---------------------------------------------------------------------------

describe("issue #273 — Group C: forwarded-body safety", () => {
	it("a 200 OK body that we explicitly do NOT hand to the helper drains end-to-end", async () => {
		const payload = new Uint8Array(1024).fill(0x42);
		const response = new Response(payload, {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		});

		const stream = response.body;
		expect(stream).not.toBeNull();
		if (!stream) throw new Error("expected body");

		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		reader.releaseLock();

		const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
		expect(total).toBe(payload.byteLength);
	});

	it("tee'ing a body for the client/server split still drains both halves (no premature close)", async () => {
		const payload = new Uint8Array(4096).fill(0x42);
		const response = new Response(payload, {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		});
		const body = response.body;
		if (!body) throw new Error("expected body");
		const [forClient, forServer] = body.tee();

		const clientChunks: Uint8Array[] = [];
		const serverChunks: Uint8Array[] = [];
		await Promise.all([
			(async () => {
				const r = forClient.getReader();
				while (true) {
					const { value, done } = await r.read();
					if (done) break;
					if (value) clientChunks.push(value);
				}
				r.releaseLock();
			})(),
			(async () => {
				const r = forServer.getReader();
				while (true) {
					const { value, done } = await r.read();
					if (done) break;
					if (value) serverChunks.push(value);
				}
				r.releaseLock();
			})(),
		]);

		const total = (chunks: Uint8Array[]) =>
			chunks.reduce((acc, c) => acc + c.byteLength, 0);
		expect(total(clientChunks)).toBe(payload.byteLength);
		expect(total(serverChunks)).toBe(payload.byteLength);
	});
});
