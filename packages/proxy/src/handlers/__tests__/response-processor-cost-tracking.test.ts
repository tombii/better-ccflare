import { afterEach, describe, expect, it } from "bun:test";
import {
	getCostTrackingEpoch,
	setCostTrackingEnabled,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import { updateAccountMetadata } from "../response-processor";

afterEach(() => setCostTrackingEnabled(true));

describe("provider metadata cost writes across a tracking gap", () => {
	for (const isStream of [false, true])
		for (const gap of [
			"before-parser",
			"during-parser",
			"after-enqueue",
		] as const) {
			it(`${isStream ? "stream" : "JSON"}: omits stale cost ${gap}`, async () => {
				const originalEpoch = getCostTrackingEpoch();
				const jobs: Array<() => Promise<void>> = [];
				const saved: Record<string, unknown>[] = [];
				let finish!: (value: Record<string, unknown>) => void;
				let parsed!: () => void;
				const started = new Promise<void>((resolve) => {
					parsed = resolve;
				});
				const parse = () => {
					parsed();
					return new Promise<Record<string, unknown>>((resolve) => {
						finish = resolve;
					});
				};
				const ctx = {
					provider: {
						name: "fixture",
						parseRateLimit: () => ({ isRateLimited: false }),
						isStreamingResponse: () => isStream,
						parseUsage: parse,
						extractUsageInfo: parse,
					},
					dbOps: {
						updateAccountUsage: async () => {},
						updateRequestUsage: async (
							_id: string,
							usage: Record<string, unknown>,
						) => {
							saved.push(usage);
						},
					},
					asyncWriter: {
						enqueue: (job: () => Promise<void>) => {
							jobs.push(job);
						},
					},
				} as unknown as ProxyContext;
				const gapNow = () => {
					setCostTrackingEnabled(false);
					setCostTrackingEnabled(true);
				};
				if (gap === "before-parser") gapNow();
				updateAccountMetadata(
					{ id: "account", name: "fixture", provider: "fixture" } as Account,
					new Response("{}", {
						headers: { "content-type": "application/json" },
					}),
					ctx,
					"request",
					false,
					Date.now(),
					originalEpoch,
				);
				await started;
				if (gap === "during-parser") gapNow();
				finish({ model: "claude-opus-4-6", totalTokens: 321, costUsd: 99 });
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (gap === "after-enqueue") gapNow();
				for (const job of jobs) await job();
				expect(saved).toHaveLength(1);
				expect(saved[0].totalTokens).toBe(321);
				expect(saved[0].costUsd).toBeUndefined();
			});
		}
});
