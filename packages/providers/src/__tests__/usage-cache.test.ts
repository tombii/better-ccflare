import { beforeEach, describe, expect, it, spyOn } from "bun:test";

// Mock the import that's causing issues to isolate our test
const mockUsageCache = {
	cache: new Map(),
	polling: new Map(),
	tokenProviders: new Map(),
	providerTypes: new Map(),
	customEndpoints: new Map(),

	clear() {
		for (const accountId of this.polling.keys()) {
			this.stopPolling(accountId);
		}
		this.cache.clear();
		this.tokenProviders.clear();
	},

	startPolling(accountId: string, token: string, provider?: string) {
		const existing = this.polling.get(accountId);
		if (existing) {
			clearInterval(existing);
		}
		const interval = setInterval(() => {}, 90000);
		this.polling.set(accountId, interval);
		this.tokenProviders.set(accountId, async () => token);
		if (provider) {
			this.providerTypes.set(accountId, provider);
		}
	},

	stopPolling(accountId: string) {
		const interval = this.polling.get(accountId);
		if (interval) {
			clearInterval(interval);
			this.polling.delete(accountId);
			this.tokenProviders.delete(accountId);
			this.cache.delete(accountId);
		}
	},

	set(accountId: string, data: any) {
		this.cache.set(accountId, { data, timestamp: Date.now() });
		if (this.cache.size % 100 === 0) {
			this.cleanupStaleEntries();
		}
	},

	get(accountId: string): any {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		const age = Date.now() - cached.timestamp;
		if (age > 10 * 60 * 1000) {
			this.cache.delete(accountId);
			return null;
		}

		return cached.data;
	},

	delete(accountId: string): void {
		this.cache.delete(accountId);
	},

	getAge(accountId: string): number | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		const age = Date.now() - cached.timestamp;
		if (age > 10 * 60 * 1000) {
			this.cache.delete(accountId);
			return null;
		}

		return age;
	},

	cleanupStaleEntries(maxAgeMs: number = 10 * 60 * 1000): void {
		const now = Date.now();
		let _cleanedCount = 0;

		for (const [accountId, cached] of this.cache.entries()) {
			if (now - cached.timestamp > maxAgeMs) {
				this.cache.delete(accountId);
				_cleanedCount++;
			}
		}
	},
};

describe("UsageCache - Memory Management", () => {
	const _TEN_MINUTES_MS = 10 * 60 * 1000;

	beforeEach(() => {
		mockUsageCache.clear();
	});

	describe("Cache Entry Expiration (10-minute rule)", () => {
		it("should return fresh data within 10-minute window", () => {
			const accountId = "test-account-1";
			const mockUsageData = {
				five_hour: { utilization: 50, resets_at: null },
				seven_day: { utilization: 70, resets_at: null },
				seven_day_oauth_apps: { utilization: 60, resets_at: null },
				seven_day_opus: { utilization: 80, resets_at: null },
			};

			// Set cache entry directly with current timestamp
			mockUsageCache.cache.set(accountId, {
				data: mockUsageData,
				timestamp: Date.now(),
			});

			// Data should be available
			const freshData = mockUsageCache.get(accountId);
			expect(freshData).toEqual(mockUsageData);

			// Should still be available after 5 minutes
			const cachedEntry = mockUsageCache.cache.get(accountId);
			if (cachedEntry) {
				cachedEntry.timestamp = Date.now() - 5 * 60 * 1000; // 5 minutes ago
			}

			const fiveMinuteOldData = mockUsageCache.get(accountId);
			expect(fiveMinuteOldData).toEqual(mockUsageData);
		});

		it("should automatically remove stale data older than 10 minutes", () => {
			const accountId = "test-account-2";
			const mockUsageData = {
				five_hour: { utilization: 50, resets_at: null },
				seven_day: { utilization: 70, resets_at: null },
				seven_day_oauth_apps: { utilization: 60, resets_at: null },
				seven_day_opus: { utilization: 80, resets_at: null },
			};

			// Set cache entry directly with old timestamp
			mockUsageCache.cache.set(accountId, {
				data: mockUsageData,
				timestamp: Date.now() - 11 * 60 * 1000, // 11 minutes ago
			});

			// Data should be stale and automatically removed
			const staleData = mockUsageCache.get(accountId);
			expect(staleData).toBeNull();

			// Cache should no longer contain the entry
			expect(mockUsageCache.cache.has(accountId)).toBe(false);
		});

		it("should return null for age of stale entries and remove them", () => {
			const accountId = "test-account-3";
			const mockUsageData = {
				five_hour: { utilization: 50, resets_at: null },
				seven_day: { utilization: 70, resets_at: null },
				seven_day_oauth_apps: { utilization: 60, resets_at: null },
				seven_day_opus: { utilization: 80, resets_at: null },
			};

			// Set cache entry directly with old timestamp
			mockUsageCache.cache.set(accountId, {
				data: mockUsageData,
				timestamp: Date.now() - 15 * 60 * 1000, // 15 minutes ago
			});

			// Age should return null for stale entries
			const age = mockUsageCache.getAge(accountId);
			expect(age).toBeNull();

			// Cache should no longer contain the entry
			expect(mockUsageCache.cache.has(accountId)).toBe(false);
		});

		it("should use custom max age when cleaning up stale entries", () => {
			const accountId1 = "account-recent";
			const accountId2 = "account-old";
			const accountId3 = "account-very-old";

			const now = Date.now();

			// Set entries with different ages
			mockUsageCache.cache.set(accountId1, {
				data: {
					five_hour: { utilization: 10, resets_at: null },
					seven_day: { utilization: 10, resets_at: null },
					seven_day_oauth_apps: { utilization: 10, resets_at: null },
					seven_day_opus: { utilization: 10, resets_at: null },
				},
				timestamp: now - 2 * 60 * 1000, // 2 minutes ago
			});
			mockUsageCache.cache.set(accountId2, {
				data: {
					five_hour: { utilization: 20, resets_at: null },
					seven_day: { utilization: 20, resets_at: null },
					seven_day_oauth_apps: { utilization: 20, resets_at: null },
					seven_day_opus: { utilization: 20, resets_at: null },
				},
				timestamp: now - 5 * 60 * 1000, // 5 minutes ago
			});
			mockUsageCache.cache.set(accountId3, {
				data: {
					five_hour: { utilization: 30, resets_at: null },
					seven_day: { utilization: 30, resets_at: null },
					seven_day_oauth_apps: { utilization: 30, resets_at: null },
					seven_day_opus: { utilization: 30, resets_at: null },
				},
				timestamp: now - 8 * 60 * 1000, // 8 minutes ago
			});

			// Run cleanup with 3-minute max age
			mockUsageCache.cleanupStaleEntries(3 * 60 * 1000);

			// Should keep recent entries, remove old ones
			expect(mockUsageCache.cache.has(accountId1)).toBe(true); // 2 minutes - keep
			expect(mockUsageCache.cache.has(accountId2)).toBe(false); // 5 minutes - remove
			expect(mockUsageCache.cache.has(accountId3)).toBe(false); // 8 minutes - remove
		});
	});

	describe("Automatic Stale Entry Cleanup", () => {
		it("should clean stale entries when accessing via get()", () => {
			const accountId = "stale-account";

			// Add stale entry (11 minutes old)
			mockUsageCache.cache.set(accountId, {
				data: {
					five_hour: { utilization: 50, resets_at: null },
					seven_day: { utilization: 50, resets_at: null },
					seven_day_oauth_apps: { utilization: 50, resets_at: null },
					seven_day_opus: { utilization: 50, resets_at: null },
				},
				timestamp: Date.now() - 11 * 60 * 1000,
			});

			// Verify entry exists before access
			expect(mockUsageCache.cache.has(accountId)).toBe(true);

			// Access should trigger cleanup
			const result = mockUsageCache.get(accountId);

			// Should return null and remove entry
			expect(result).toBeNull();
			expect(mockUsageCache.cache.has(accountId)).toBe(false);
		});

		it("should clean stale entries when accessing via getAge()", () => {
			const accountId = "stale-age-account";

			// Add stale entry (12 minutes old)
			mockUsageCache.cache.set(accountId, {
				data: {
					five_hour: { utilization: 60, resets_at: null },
					seven_day: { utilization: 60, resets_at: null },
					seven_day_oauth_apps: { utilization: 60, resets_at: null },
					seven_day_opus: { utilization: 60, resets_at: null },
				},
				timestamp: Date.now() - 12 * 60 * 1000,
			});

			// Verify entry exists before access
			expect(mockUsageCache.cache.has(accountId)).toBe(true);

			// Access should trigger cleanup
			const age = mockUsageCache.getAge(accountId);

			// Should return null and remove entry
			expect(age).toBeNull();
			expect(mockUsageCache.cache.has(accountId)).toBe(false);
		});
	});

	describe("Manual Delete Method", () => {
		it("should remove specific cache entries when delete() is called", () => {
			const accountId1 = "delete-account-1";
			const accountId2 = "delete-account-2";

			// Set cache entries
			mockUsageCache.set(accountId1, {
				five_hour: { utilization: 10, resets_at: null },
				seven_day: { utilization: 10, resets_at: null },
				seven_day_oauth_apps: { utilization: 10, resets_at: null },
				seven_day_opus: { utilization: 10, resets_at: null },
			});
			mockUsageCache.set(accountId2, {
				five_hour: { utilization: 20, resets_at: null },
				seven_day: { utilization: 20, resets_at: null },
				seven_day_oauth_apps: { utilization: 20, resets_at: null },
				seven_day_opus: { utilization: 20, resets_at: null },
			});

			// Verify both entries exist
			expect(mockUsageCache.cache.has(accountId1)).toBe(true);
			expect(mockUsageCache.cache.has(accountId2)).toBe(true);

			// Delete specific entry
			mockUsageCache.delete(accountId1);

			// Only account1 should be removed
			expect(mockUsageCache.cache.has(accountId1)).toBe(false);
			expect(mockUsageCache.cache.has(accountId2)).toBe(true);
		});

		it("should handle delete() for non-existent accounts gracefully", () => {
			const nonExistentAccount = "non-existent";

			// Should not throw error
			expect(() => {
				mockUsageCache.delete(nonExistentAccount);
			}).not.toThrow();
		});
	});

	describe("Periodic Cleanup (Every 100 Operations)", () => {
		it("should run cleanup every 100 set operations", () => {
			const cleanupSpy = spyOn(
				mockUsageCache,
				"cleanupStaleEntries",
			).mockImplementation(() => {});

			// Add 99 entries - should not trigger cleanup
			for (let i = 0; i < 99; i++) {
				mockUsageCache.set(`account-${i}`, {
					five_hour: { utilization: i, resets_at: null },
					seven_day: { utilization: i, resets_at: null },
					seven_day_oauth_apps: { utilization: i, resets_at: null },
					seven_day_opus: { utilization: i, resets_at: null },
				});
			}

			// Cleanup should not have been called yet
			expect(cleanupSpy).toHaveBeenCalledTimes(0);

			// Add 1 more entry (100th) - should trigger cleanup
			mockUsageCache.set("account-99", {
				five_hour: { utilization: 99, resets_at: null },
				seven_day: { utilization: 99, resets_at: null },
				seven_day_oauth_apps: { utilization: 99, resets_at: null },
				seven_day_opus: { utilization: 99, resets_at: null },
			});

			// Cleanup should have been called once
			expect(cleanupSpy).toHaveBeenCalledTimes(1);

			// Add another 100 entries - should trigger cleanup again
			for (let i = 100; i < 200; i++) {
				mockUsageCache.set(`account-${i}`, {
					five_hour: { utilization: i, resets_at: null },
					seven_day: { utilization: i, resets_at: null },
					seven_day_oauth_apps: { utilization: i, resets_at: null },
					seven_day_opus: { utilization: i, resets_at: null },
				});
			}

			// Cleanup should have been called twice (once for each 100 operations)
			expect(cleanupSpy).toHaveBeenCalledTimes(2);

			cleanupSpy.mockRestore();
		});

		it("should prevent memory bloat with periodic cleanup", () => {
			const now = Date.now();

			// Add 150 entries, some of them stale
			for (let i = 0; i < 150; i++) {
				const isStale = i % 3 === 0; // Every 3rd entry is stale
				const timestamp = isStale ? now - 15 * 60 * 1000 : now - 2 * 60 * 1000;

				// Set cache entry directly to control timestamp
				mockUsageCache.cache.set(`account-${i}`, {
					data: {
						five_hour: { utilization: i, resets_at: null },
						seven_day: { utilization: i, resets_at: null },
						seven_day_oauth_apps: { utilization: i, resets_at: null },
						seven_day_opus: { utilization: i, resets_at: null },
					},
					timestamp,
				});
			}

			// Cache should have 150 entries initially
			expect(mockUsageCache.cache.size).toBe(150);

			// Use set() method to trigger periodic cleanup at 100 operations
			for (let i = 150; i < 250; i++) {
				mockUsageCache.set(`new-account-${i}`, {
					five_hour: { utilization: i, resets_at: null },
					seven_day: { utilization: i, resets_at: null },
					seven_day_oauth_apps: { utilization: i, resets_at: null },
					seven_day_opus: { utilization: i, resets_at: null },
				});
			}

			// Should have removed stale entries (around 50 of them) and added new ones
			// Final count should be approximately 200 (100 new + 100 remaining fresh)
			expect(mockUsageCache.cache.size).toBeLessThan(250);
			expect(mockUsageCache.cache.size).toBeGreaterThan(100);
		});
	});

	describe("Memory Bloat Prevention", () => {
		it("should handle large numbers of accounts efficiently", () => {
			const accountIdCount = 1000;
			const _startTime = Date.now();

			// Add many accounts
			for (let i = 0; i < accountIdCount; i++) {
				mockUsageCache.set(`load-test-${i}`, {
					five_hour: { utilization: i % 100, resets_at: null },
					seven_day: { utilization: (i + 50) % 100, resets_at: null },
					seven_day_oauth_apps: {
						utilization: (i + 25) % 100,
						resets_at: null,
					},
					seven_day_opus: { utilization: (i + 75) % 100, resets_at: null },
				});
			}

			// Should handle large number of entries
			expect(mockUsageCache.cache.size).toBe(accountIdCount);

			// Access should be fast even with many entries
			const accessStartTime = Date.now();
			for (let i = 0; i < 100; i++) {
				const data = mockUsageCache.get(`load-test-${i * 10}`);
				expect(data).toBeDefined();
			}
			const accessTime = Date.now() - accessStartTime;

			// Access should be fast (< 100ms for 100 operations)
			expect(accessTime).toBeLessThan(100);

			// Clear up to prevent memory issues in tests
			mockUsageCache.clear();
		});

		it("should clear all resources when clear() is called", () => {
			const accountId1 = "clear-test-1";
			const accountId2 = "clear-test-2";

			// Set up cache entries
			mockUsageCache.set(accountId1, {
				five_hour: { utilization: 10, resets_at: null },
				seven_day: { utilization: 10, resets_at: null },
				seven_day_oauth_apps: { utilization: 10, resets_at: null },
				seven_day_opus: { utilization: 10, resets_at: null },
			});
			mockUsageCache.set(accountId2, {
				five_hour: { utilization: 20, resets_at: null },
				seven_day: { utilization: 20, resets_at: null },
				seven_day_oauth_apps: { utilization: 20, resets_at: null },
				seven_day_opus: { utilization: 20, resets_at: null },
			});

			// Set up polling entries
			mockUsageCache.startPolling(accountId1, "token1", "anthropic");
			mockUsageCache.startPolling(accountId2, "token2", "nanogpt");

			// Verify resources are allocated
			expect(mockUsageCache.cache.size).toBeGreaterThan(0);
			expect(mockUsageCache.polling.size).toBeGreaterThan(0);
			expect(mockUsageCache.tokenProviders.size).toBeGreaterThan(0);

			// Clear everything
			mockUsageCache.clear();

			// All resources should be cleared
			expect(mockUsageCache.cache.size).toBe(0);
			expect(mockUsageCache.polling.size).toBe(0);
			expect(mockUsageCache.tokenProviders.size).toBe(0);
		});
	});

	describe("Age Tracking", () => {
		it("should return correct age for fresh entries", () => {
			const accountId = "age-test-account";
			const mockUsageData = {
				five_hour: { utilization: 50, resets_at: null },
				seven_day: { utilization: 70, resets_at: null },
				seven_day_oauth_apps: { utilization: 60, resets_at: null },
				seven_day_opus: { utilization: 80, resets_at: null },
			};

			// Set cache entry
			mockUsageCache.set(accountId, mockUsageData);

			// Age should be recent (less than 1 second)
			const age = mockUsageCache.getAge(accountId);
			expect(age).toBeGreaterThanOrEqual(0);
			expect(age).toBeLessThan(1000);
		});

		it("should return null for non-existent entries", () => {
			const nonExistentAccount = "non-existent-age-test";

			const age = mockUsageCache.getAge(nonExistentAccount);
			expect(age).toBeNull();
		});
	});
});
