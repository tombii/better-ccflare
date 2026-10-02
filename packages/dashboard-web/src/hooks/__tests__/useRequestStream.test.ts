import { describe, expect, it } from "bun:test";
import {
	reconnectDelay,
	shouldReconnectOnHeartbeat,
	shouldReconnectOnWake,
	shouldRefetchOnOpen,
} from "../useRequestStream";

describe("shouldRefetchOnOpen", () => {
	it("does not refetch on the first open", () => {
		expect(shouldRefetchOnOpen(false, 0)).toBe(false);
	});

	it("refetches when the same stream re-opens", () => {
		expect(shouldRefetchOnOpen(true, 0)).toBe(true);
	});

	it("refetches on a retried connection's first open", () => {
		expect(shouldRefetchOnOpen(false, 1)).toBe(true);
	});
});

describe("reconnectDelay", () => {
	it("backs off exponentially from 1s", () => {
		expect(reconnectDelay(0, () => 0)).toBe(1000);
		expect(reconnectDelay(1, () => 0)).toBe(2000);
		expect(reconnectDelay(3, () => 0)).toBe(8000);
	});

	it("caps the base delay at 30s for any retry count", () => {
		expect(reconnectDelay(5, () => 0)).toBe(30000);
		expect(reconnectDelay(1000, () => 0)).toBe(30000);
	});

	it("adds up to 25% jitter", () => {
		expect(reconnectDelay(0, () => 0.5)).toBe(1125);
		expect(reconnectDelay(10, () => 1)).toBe(37500);
	});
});

describe("shouldReconnectOnWake", () => {
	it("reconnects when the stream is not open", () => {
		expect(shouldReconnectOnWake(undefined)).toBe(true);
		expect(shouldReconnectOnWake(0)).toBe(true);
		expect(shouldReconnectOnWake(2)).toBe(true);
	});

	it("leaves an open stream alone", () => {
		expect(shouldReconnectOnWake(1)).toBe(false);
	});
});

describe("shouldReconnectOnHeartbeat", () => {
	it("reconnects only a closed source", () => {
		expect(shouldReconnectOnHeartbeat(2)).toBe(true);
		expect(shouldReconnectOnHeartbeat(0)).toBe(false);
		expect(shouldReconnectOnHeartbeat(1)).toBe(false);
	});
});
