import { describe, expect, it, mock } from "bun:test";
import {
	type UsageCacheRegistrar,
	registerMinimaxUsagePolling,
	supportsRefreshBackedUsagePolling,
} from "./server";

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

describe("registerMinimaxUsagePolling", () => {
	function makeAccount(
		overrides: Partial<{
			id: string;
			name: string;
			provider: string;
			api_key: string | null;
		}> = {},
	) {
		return {
			id: "acc-1",
			name: "minimax-account-1",
			provider: "minimax",
			api_key: "test-key",
			...overrides,
		} as unknown as Parameters<typeof registerMinimaxUsagePolling>[0];
	}

	function makeRegistrar() {
		const startPolling = mock(
			(
				_accountId: string,
				_tokenProvider: () => Promise<string>,
				_provider: string,
				_intervalMs: number,
			) => {},
		);
		return {
			registrar: { startPolling } as unknown as UsageCacheRegistrar,
			startPolling,
		};
	}

	it("registers polling for a Minimax account with an API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(makeAccount(), registrar, 30_000);

		expect(result).toBe(true);
		expect(startPolling).toHaveBeenCalledTimes(1);
		const call = startPolling.mock.calls[0];
		expect(call?.[0]).toBe("acc-1");
		expect(call?.[2]).toBe("minimax");
		expect(call?.[3]).toBe(30_000);
		expect(typeof call?.[1]).toBe("function");
	});

	it("the registered token provider returns the account's API key", async () => {
		const { registrar, startPolling } = makeRegistrar();
		registerMinimaxUsagePolling(
			makeAccount({ api_key: "secret-key" }),
			registrar,
			30_000,
		);

		const tokenProvider = startPolling.mock.calls[0]?.[1];
		expect(await tokenProvider()).toBe("secret-key");
	});

	it("does not register polling for non-Minimax accounts", () => {
		const { registrar, startPolling } = makeRegistrar();
		// The block calls registerMinimaxUsagePolling only for accounts where
		// accounts.filter((a) => a.provider === "minimax") matched, so the
		// helper itself is the load-bearing gate. If the filter goes away and
		// this helper is called for every provider, the false return here is
		// what keeps the wrong accounts from being polled.
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "zai", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "nanogpt", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "anthropic", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});

	it("does not register polling when a Minimax account has no API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(
			makeAccount({ api_key: null }),
			registrar,
			30_000,
		);

		expect(result).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});

	it("does not register polling when a Minimax account has an empty API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(
			makeAccount({ api_key: "" }),
			registrar,
			30_000,
		);

		expect(result).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
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
