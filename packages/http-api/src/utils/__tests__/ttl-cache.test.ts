import { describe, expect, it } from "bun:test";
import { createTtlCache } from "../ttl-cache";

describe("createTtlCache", () => {
	it("returns the cached value within the TTL", async () => {
		let t = 0;
		const cache = createTtlCache<number>(1000, () => t);
		let calls = 0;
		const loader = async () => ++calls;
		expect(await cache.get("a", loader)).toBe(1);
		t = 999;
		expect(await cache.get("a", loader)).toBe(1);
		expect(calls).toBe(1);
	});

	it("reloads after the TTL expires", async () => {
		let t = 0;
		const cache = createTtlCache<number>(1000, () => t);
		let calls = 0;
		const loader = async () => ++calls;
		await cache.get("a", loader);
		t = 1000;
		expect(await cache.get("a", loader)).toBe(2);
	});

	it("keeps keys separate", async () => {
		const cache = createTtlCache<string>(1000, () => 0);
		expect(await cache.get("a", async () => "A")).toBe("A");
		expect(await cache.get("b", async () => "B")).toBe("B");
		expect(await cache.get("a", async () => "X")).toBe("A");
	});

	it("shares one in-flight promise for concurrent calls", async () => {
		const cache = createTtlCache<number>(1000, () => 0);
		let calls = 0;
		let release: (v: number) => void = () => {};
		const loader = () =>
			new Promise<number>((r) => {
				calls++;
				release = r;
			});
		const p1 = cache.get("a", loader);
		const p2 = cache.get("a", loader);
		release(7);
		expect(await Promise.all([p1, p2])).toEqual([7, 7]);
		expect(calls).toBe(1);
	});

	it("does not cache rejections", async () => {
		const cache = createTtlCache<number>(1000, () => 0);
		await expect(
			cache.get("a", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await cache.get("a", async () => 5)).toBe(5);
	});

	it("bounds the number of keys, evicting the oldest", async () => {
		const cache = createTtlCache<number>(1000, () => 0);
		let calls = 0;
		const loader = async () => ++calls;
		for (let i = 0; i < 40; i++) await cache.get(`k${i}`, loader);
		expect(calls).toBe(40);
		await cache.get("k39", loader); // newest still cached
		expect(calls).toBe(40);
		await cache.get("k0", loader); // oldest evicted
		expect(calls).toBe(41);
	});

	it("clear() drops entries", async () => {
		const cache = createTtlCache<number>(1000, () => 0);
		let calls = 0;
		const loader = async () => ++calls;
		await cache.get("a", loader);
		cache.clear();
		await cache.get("a", loader);
		expect(calls).toBe(2);
	});
});
