import { describe, expect, it } from "bun:test";
import { AsyncDbWriter } from "@better-ccflare/database";
import { createHealthHandler } from "../health";

describe("health runtime payload", () => {
	it("includes runtime health when callbacks are provided", async () => {
		const db = {
			get: async () => ({ count: 3 }),
		} as unknown as import("@better-ccflare/database").BunSqlAdapter;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(
			db,
			config,
			() => ({ healthy: true, failureCount: 0, queuedJobs: 2 }),
			() => ({
				state: "ready",
				pendingAcks: 1,
				lastError: null,
				startedAt: 123,
			}),
		);

		const response = await handler();
		const body = (await response.json()) as Record<string, any>;

		expect(body.status).toBe("ok");
		expect(body.accounts).toBe(3);
		expect(body.strategy).toBe("session");
		expect(body.runtime).toBeDefined();
		expect(body.runtime.asyncWriter).toEqual({
			healthy: true,
			failureCount: 0,
			queuedJobs: 2,
		});
		expect(body.runtime.usageWorker).toEqual({
			state: "ready",
			pendingAcks: 1,
			lastError: null,
			startedAt: 123,
		});
	});

	it("omits runtime health when callbacks are not provided", async () => {
		const db = {
			get: async () => ({ count: 1 }),
		} as unknown as import("@better-ccflare/database").BunSqlAdapter;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(db, config);
		const response = await handler();
		const body = (await response.json()) as Record<string, unknown>;

		expect(body).not.toHaveProperty("runtime");
	});
});

describe("AsyncDbWriter.getHealth", () => {
	it("reports healthy state with zero failures by default", async () => {
		const writer = new AsyncDbWriter();
		const health = writer.getHealth();

		expect(health).toEqual({
			healthy: true,
			failureCount: 0,
			queuedJobs: 0,
		});

		await writer.dispose();
	});

	it("returns numeric queuedJobs after enqueue", async () => {
		const writer = new AsyncDbWriter();
		writer.enqueue(() => {});

		const health = writer.getHealth();
		expect(typeof health.queuedJobs).toBe("number");
		expect(health.queuedJobs).toBeGreaterThanOrEqual(0);

		await writer.dispose();
	});
});
