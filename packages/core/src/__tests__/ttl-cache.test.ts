import { describe, expect, it, beforeEach } from "bun:test";
import { TtlCache } from "@better-ccflare/core";

describe("TtlCache", () => {
	let currentTime: number;
	let now: () => number;

	beforeEach(() => {
		currentTime = 1000000;
		now = () => currentTime;
	});

	it("returns undefined before set", () => {
		const cache = new TtlCache(1000, now);
		expect(cache.get()).toBeUndefined();
	});

	it("returns value after set within TTL", () => {
		const cache = new TtlCache(1000, now);
		cache.set("hello");
		expect(cache.get()).toBe("hello");
	});

	it("returns undefined after TTL expires", () => {
		const cache = new TtlCache(1000, now);
		cache.set("hello");
		currentTime = 1001001; // 1001ms later
		expect(cache.get()).toBeUndefined();
	});

	it("respects custom TTL", () => {
		const shortCache = new TtlCache(50, now);
		shortCache.set(42);

		currentTime = 1000040; // 40ms later — still valid
		expect(shortCache.get()).toBe(42);

		currentTime = 1000051; // 51ms later — expired
		expect(shortCache.get()).toBeUndefined();
	});

	it("set() overwrites previous value", () => {
		const cache = new TtlCache(1000, now);
		cache.set("first");
		expect(cache.get()).toBe("first");

		cache.set("second");
		expect(cache.get()).toBe("second");
	});

	it("clear() removes value", () => {
		const cache = new TtlCache(1000, now);
		cache.set("hello");
		expect(cache.get()).toBe("hello");

		cache.clear();
		expect(cache.get()).toBeUndefined();
	});

	it("clear() resets staleness", () => {
		const cache = new TtlCache(1000, now);
		cache.set("hello");
		expect(cache.isStale()).toBeFalse();

		cache.clear();
		expect(cache.isStale()).toBeTrue();
	});

	describe("size", () => {
		it("returns 0 before set", () => {
			const cache = new TtlCache(1000, now);
			expect(cache.size).toBe(0);
		});

		it("returns 1 after set within TTL", () => {
			const cache = new TtlCache(1000, now);
			cache.set("hello");
			expect(cache.size).toBe(1);
		});

		it("returns 0 after TTL expires", () => {
			const cache = new TtlCache(1000, now);
			cache.set("hello");
			currentTime = 1001001;
			expect(cache.size).toBe(0);
		});

		it("returns 0 after clear", () => {
			const cache = new TtlCache(1000, now);
			cache.set("hello");
			cache.clear();
			expect(cache.size).toBe(0);
		});
	});

	describe("isStale", () => {
		it("returns true before set", () => {
			const cache = new TtlCache(1000, now);
			expect(cache.isStale()).toBeTrue();
		});

		it("returns false after set within TTL", () => {
			const cache = new TtlCache(1000, now);
			cache.set("hello");
			expect(cache.isStale()).toBeFalse();
		});

		it("returns true after TTL expires", () => {
			const cache = new TtlCache(1000, now);
			cache.set("hello");
			currentTime = 1001001;
			expect(cache.isStale()).toBeTrue();
		});

		it("returns true after clear", () => {
			const cache = new TtlCache(1000, now);
			cache.set("hello");
			cache.clear();
			expect(cache.isStale()).toBeTrue();
		});
	});
});
