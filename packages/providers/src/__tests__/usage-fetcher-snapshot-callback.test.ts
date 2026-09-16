/**
 * Regression coverage for the P1 bug found in review of PR #470 (issue #467):
 * `UsageCache._doFetchAndCache`'s nanogpt/zai/xai/minimax branches fetched
 * data, cached it, and returned — without ever looking up or invoking the
 * stored `onSnapshot` callback the way the codex and anthropic branches do.
 * That meant `createUsageSnapshotRecorder`'s callback (wired in
 * apps/server/src/server.ts for these providers) was stored via
 * `startPolling` but never fired on a real poll, so
 * `applyUsagePauseThresholds` never ran and usage-pause thresholds
 * configured on these accounts silently did nothing.
 *
 * These tests drive the REAL `UsageCache` singleton (`usageCache`, exported
 * from `../usage-fetcher`) through `startPolling`, which performs an
 * immediate fetch synchronously in a `.then()` continuation. Only
 * `global.fetch` is mocked — not `startPolling` itself, and not the
 * `fetch*UsageData` module functions — so the real `_doFetchAndCache`
 * branch per provider is exercised end-to-end, exactly the path that let
 * this bug slip through unit tests which mocked `startPolling` wholesale.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "../usage-fetcher";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

// ── xAI gRPC-web wire helpers (verbatim from xai-usage-fetcher.test.ts) ────

function varint(value: number): number[] {
	const out: number[] = [];
	let v = value;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
	return out;
}

function float32(value: number): number[] {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setFloat32(0, value, true);
	return [...bytes];
}

function frame(flags: number, payload: Uint8Array | string): Uint8Array {
	const payloadBytes =
		typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
	const out = new Uint8Array(5 + payloadBytes.length);
	out[0] = flags;
	out[1] = (payloadBytes.length >>> 24) & 0xff;
	out[2] = (payloadBytes.length >>> 16) & 0xff;
	out[3] = (payloadBytes.length >>> 8) & 0xff;
	out[4] = payloadBytes.length & 0xff;
	out.set(payloadBytes, 5);
	return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const len = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(len);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function xaiCreditsPayload(
	percent: number,
	resetEpochSeconds: number,
): Uint8Array {
	const resetSub = new Uint8Array([0x08, ...varint(resetEpochSeconds)]);
	const currentPeriod = new Uint8Array([
		0x0d, // field 1, fixed32: credit_usage_percent
		...float32(percent),
		0x2a, // field 5, length-delimited: reset window
		...varint(resetSub.length),
		...resetSub,
	]);
	return new Uint8Array([
		0x0a, // field 1, length-delimited: current_period
		...varint(currentPeriod.length),
		...currentPeriod,
	]);
}

function xaiGrpcWebResponse(
	percent: number,
	resetEpochSeconds: number,
): Response {
	const body = concatBytes(
		frame(0x00, xaiCreditsPayload(percent, resetEpochSeconds)),
		frame(0x80, "grpc-status: 0\r\n"),
	);
	return new Response(body, { status: 200 });
}

// ── shared harness ──────────────────────────────────────────────────────────

describe("UsageCache._doFetchAndCache onSnapshot wiring (real poll cycle)", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach((): void => {
		globalThis.fetch = originalFetch;
	});

	// startPolling triggers the fetch inside a `.then()` continuation, not
	// synchronously — flush the microtask queue (plus a real timer tick,
	// since fetch itself resolves asynchronously) before asserting.
	async function flush(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("fires onSnapshot for nanogpt after a real poll", async () => {
		const accountId = "snapshot-cb-nanogpt";
		globalThis.fetch = mock(async () =>
			jsonResponse({
				active: true,
				limits: { daily: 100, monthly: 1000 },
				enforceDailyLimit: true,
				daily: { used: 10, remaining: 90, percentUsed: 0.1, resetAt: 1 },
				monthly: { used: 100, remaining: 900, percentUsed: 0.1, resetAt: 2 },
				state: "active",
				graceUntil: null,
			}),
		) as unknown as typeof fetch;

		const onSnapshot = mock(() => {});
		usageCache.startPolling(
			accountId,
			async () => "token",
			"nanogpt",
			90000,
			undefined,
			undefined,
			undefined,
			undefined,
			onSnapshot,
		);
		await flush();

		expect(onSnapshot).toHaveBeenCalledTimes(1);
		expect(onSnapshot).toHaveBeenCalledWith(
			accountId,
			expect.objectContaining({ active: true }),
		);

		usageCache.stopPolling(accountId);
	});

	it("fires onSnapshot for zai after a real poll", async () => {
		const accountId = "snapshot-cb-zai";
		globalThis.fetch = mock(async () =>
			jsonResponse({
				code: 200,
				msg: "Operation successful",
				success: true,
				data: {
					level: "pro",
					limits: [
						{
							type: "TOKENS_LIMIT",
							unit: 3,
							number: 5,
							percentage: 10,
							nextResetTime: 1788455420775,
						},
					],
				},
			}),
		) as unknown as typeof fetch;

		const onSnapshot = mock(() => {});
		usageCache.startPolling(
			accountId,
			async () => "token",
			"zai",
			90000,
			undefined,
			undefined,
			undefined,
			undefined,
			onSnapshot,
		);
		await flush();

		expect(onSnapshot).toHaveBeenCalledTimes(1);
		expect(onSnapshot).toHaveBeenCalledWith(
			accountId,
			expect.objectContaining({
				tokens_limit: expect.objectContaining({ percentage: 10 }),
			}),
		);

		usageCache.stopPolling(accountId);
	});

	it("fires onSnapshot for xai after a real poll", async () => {
		const accountId = "snapshot-cb-xai";
		globalThis.fetch = mock(async () =>
			xaiGrpcWebResponse(11.25, 1_814_400_000),
		) as unknown as typeof fetch;

		const onSnapshot = mock(() => {});
		usageCache.startPolling(
			accountId,
			async () => "token",
			"xai",
			90000,
			undefined,
			undefined,
			undefined,
			undefined,
			onSnapshot,
		);
		await flush();

		expect(onSnapshot).toHaveBeenCalledTimes(1);
		expect(onSnapshot).toHaveBeenCalledWith(
			accountId,
			expect.objectContaining({
				credits: expect.objectContaining({ utilization: 11.25 }),
			}),
		);

		usageCache.stopPolling(accountId);
	});

	it("fires onSnapshot for minimax after a real poll", async () => {
		const accountId = "snapshot-cb-minimax";
		const intervalStart = 1_700_000_000_000;
		const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
		const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
		globalThis.fetch = mock(async () =>
			jsonResponse({
				base_resp: { status_code: 0 },
				model_remains: [
					{
						model_name: "general",
						current_interval_remaining_percent: 75,
						current_interval_status: 1,
						current_interval_total_count: 100,
						current_interval_usage_count: 25,
						start_time: intervalStart,
						end_time: intervalStart + FIVE_HOUR_MS,
						remains_time: FIVE_HOUR_MS,
						current_weekly_remaining_percent: 90,
						current_weekly_status: 1,
						current_weekly_total_count: 1000,
						current_weekly_usage_count: 100,
						weekly_start_time: intervalStart,
						weekly_end_time: intervalStart + SEVEN_DAY_MS,
						weekly_remains_time: SEVEN_DAY_MS,
					},
				],
			}),
		) as unknown as typeof fetch;

		const onSnapshot = mock(() => {});
		usageCache.startPolling(
			accountId,
			async () => "token",
			"minimax",
			90000,
			undefined,
			undefined,
			undefined,
			undefined,
			onSnapshot,
		);
		await flush();

		expect(onSnapshot).toHaveBeenCalledTimes(1);
		expect(onSnapshot).toHaveBeenCalledWith(
			accountId,
			expect.objectContaining({
				five_hour: expect.objectContaining({ utilization: 25 }),
			}),
		);

		usageCache.stopPolling(accountId);
	});
});
