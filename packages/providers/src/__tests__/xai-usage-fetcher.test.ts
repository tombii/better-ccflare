import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	fetchXaiUsageData,
	parseXaiGrokCreditsResponse,
	XAI_GROK_CREDITS_ENDPOINT,
} from "../xai-usage-fetcher";

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

function concat(...parts: Uint8Array[]): Uint8Array {
	const len = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(len);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function creditsPayload(
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

describe("xAI Grok usage fetcher", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("parses Grok Build credits utilization and reset from gRPC-web frames", () => {
		const reset = 1_814_400_000; // 2027-07-01T00:00:00.000Z
		const body = concat(
			frame(0x00, creditsPayload(11.25, reset)),
			frame(0x80, "grpc-status: 0\r\n"),
		);

		const parsed = parseXaiGrokCreditsResponse(
			body,
			Date.parse("2026-06-27T00:00:00.000Z"),
		);

		expect(parsed).toEqual({
			credits: {
				utilization: 11.25,
				resets_at: "2027-07-01T00:00:00.000Z",
			},
		});
	});

	it("treats non-zero gRPC status as unavailable usage", () => {
		const body = frame(
			0x80,
			"grpc-status: 12\r\ngrpc-message: unimplemented\r\n",
		);

		expect(parseXaiGrokCreditsResponse(body)).toBeNull();
	});

	it("posts the empty gRPC-web request with Grok-compatible headers", async () => {
		const reset = 1_814_400_000;
		const responseBody = concat(
			frame(0x00, creditsPayload(42, reset)),
			frame(0x80, "grpc-status: 0\r\n"),
		);
		const fetchMock = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(XAI_GROK_CREDITS_ENDPOINT);
				expect(init?.method).toBe("POST");
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer access-token",
				);
				expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
					"application/grpc-web+proto",
				);
				expect((init?.headers as Record<string, string>)["x-grpc-web"]).toBe(
					"1",
				);
				expect([...(init?.body as Uint8Array)]).toEqual([0, 0, 0, 0, 0]);
				return new Response(responseBody, { status: 200 });
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const usage = await fetchXaiUsageData(" access-token ");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(usage?.credits.utilization).toBe(42);
		expect(usage?.credits.resets_at).toBe("2027-07-01T00:00:00.000Z");
	});
});
