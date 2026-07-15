import { describe, expect, it } from "bun:test";
import { supportsRefreshBackedUsagePolling } from "./server";

describe("supportsRefreshBackedUsagePolling", () => {
	it("includes pollable OAuth providers that need token refresh", () => {
		expect(supportsRefreshBackedUsagePolling("anthropic")).toBe(true);
		expect(supportsRefreshBackedUsagePolling("xai")).toBe(true);
	});

	it("does not include providers whose usage is not polled through this path", () => {
		expect(supportsRefreshBackedUsagePolling("codex")).toBe(false);
		expect(supportsRefreshBackedUsagePolling("qwen")).toBe(false);
		expect(supportsRefreshBackedUsagePolling("nanogpt")).toBe(false);
		expect(supportsRefreshBackedUsagePolling(null)).toBe(false);
	});
});

describe("readShutdownDrainMs", () => {
	const { readShutdownDrainMs, SHUTDOWN_DRAIN_MS_ENV } = require("./server");

	it("defaults to 60s and parses overrides", () => {
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
		expect(readShutdownDrainMs()).toBe(60_000);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "5000";
		expect(readShutdownDrainMs()).toBe(5_000);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "0";
		expect(readShutdownDrainMs()).toBe(0);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "nonsense";
		expect(readShutdownDrainMs()).toBe(60_000);
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
	});

	it("rejects numeric prefixes and clamps oversized values", () => {
		const { MAX_SHUTDOWN_DRAIN_MS } = require("./server");
		// parseInt would read "1abc" as a 1ms drain; treat it as invalid.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "1abc";
		expect(readShutdownDrainMs()).toBe(60_000);
		// Values beyond the clamp would overflow setTimeout's 32-bit delay and
		// make the watchdog fire immediately.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "99999999999";
		expect(readShutdownDrainMs()).toBe(MAX_SHUTDOWN_DRAIN_MS);
		// Beyond MAX_SAFE_INTEGER must still clamp, not fall back to 60s.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "9007199254740992";
		expect(readShutdownDrainMs()).toBe(MAX_SHUTDOWN_DRAIN_MS);
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
	});
});

describe("trackStreamForShutdown", () => {
	const { trackStreamForShutdown, abortInflightStreams } = require("./server");

	const endlessResponse = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					controller.enqueue(new TextEncoder().encode("tick\n"));
					await new Promise((r) => setTimeout(r, 20));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);

	it("errors tracked never-ending streams on abort", async () => {
		const wrapped = trackStreamForShutdown(endlessResponse());
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("wrapped response lost its body");
		await reader.read(); // stream is live
		const first = abortInflightStreams();
		expect(first.aborted).toBe(1);
		await first.settled;
		await expect(
			(async () => {
				while (true) {
					const { done } = await reader.read();
					if (done) break;
				}
			})(),
		).rejects.toThrow(/drain deadline/);
		// Registry is drained; a second sweep has nothing to abort.
		const second = abortInflightStreams();
		expect(second.aborted).toBe(0);
		await second.settled;
	});

	it("unregisters streams that complete normally", async () => {
		const wrapped = trackStreamForShutdown(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("done"));
						controller.close();
					},
				}),
			),
		);
		expect(await wrapped.text()).toBe("done");
		const result = abortInflightStreams();
		expect(result.aborted).toBe(0);
		await result.settled;
	});

	it("passes non-stream responses through untouched", () => {
		const plain = new Response(null, { status: 204 });
		expect(trackStreamForShutdown(plain)).toBe(plain);
	});

	it("resolves abort settlements after source cancellation, not a fixed sleep", async () => {
		let cancelResolved = false;
		const delayedCancelResponse = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						controller.enqueue(new TextEncoder().encode("tick\n"));
						await new Promise((r) => setTimeout(r, 20));
					},
					async cancel() {
						await new Promise((r) => setTimeout(r, 30));
						cancelResolved = true;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);

		const wrapped = trackStreamForShutdown(delayedCancelResponse());
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("wrapped response lost its body");
		await reader.read();
		const { aborted, settled } = abortInflightStreams();
		expect(aborted).toBe(1);
		expect(cancelResolved).toBe(false);
		await settled;
		expect(cancelResolved).toBe(true);
		reader.cancel().catch(() => {});
	});
});
