import { describe, expect, it } from "bun:test";
import { fetchStableSnapshot } from "../queries";

describe("fetchStableSnapshot", () => {
	it("fetches once when the sequence does not change", async () => {
		let calls = 0;
		const result = await fetchStableSnapshot(
			async () => ++calls,
			() => 0,
			3,
		);
		expect(result).toBe(1);
		expect(calls).toBe(1);
	});

	it("refetches when the sequence changes during the first fetch", async () => {
		let seq = 0;
		let calls = 0;
		const result = await fetchStableSnapshot(
			async () => {
				calls++;
				if (calls === 1) seq++;
				return calls;
			},
			() => seq,
			3,
		);
		expect(result).toBe(2);
		expect(calls).toBe(2);
	});

	it("stops at maxAttempts and returns the last snapshot", async () => {
		let seq = 0;
		let calls = 0;
		const result = await fetchStableSnapshot(
			async () => {
				seq++;
				return ++calls;
			},
			() => seq,
			3,
		);
		expect(result).toBe(3);
		expect(calls).toBe(3);
	});

	it("propagates fetch errors", async () => {
		await expect(
			fetchStableSnapshot(
				async () => {
					throw new Error("boom");
				},
				() => 0,
				3,
			),
		).rejects.toThrow("boom");
	});
});
