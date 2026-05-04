import { describe, expect, it } from "bun:test";
import { AsyncDbWriter } from "@better-ccflare/database";
import { createHealthHandler } from "../health";

describe("health runtime payload", () => {
	it("returns degraded status when no routable accounts", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "paused1", paused: true, rate_limited_until: null },
				{ name: "paused2", paused: true, rate_limited_until: null },
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(503);
		expect(body.status).toBe("unhealthy");
		expect(body.accounts).toBe(2);
	});

	it("includes runtime health when callbacks are provided", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
				{ name: "acc2", paused: false, rate_limited_until: null },
				{ name: "acc3", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(
			db,
			config,
			() => ({ healthy: true, failureCount: 0, queuedJobs: 2 }),
			() => ({
				state: "healthy",
				pendingAcks: 1,
				lastError: null,
				startedAt: 123,
			}),
		);

		const url = new URL("http://localhost/health");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, any>;

		expect(response.status).toBe(200);
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
			state: "healthy",
			pendingAcks: 1,
			lastError: null,
			startedAt: 123,
		});
	});

	it("omits runtime health when callbacks are not provided", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health");
		const response = await handler(url);
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

describe("computePoolStatus", () => {
	it("calculates pool status with mixed account states", async () => {
		const { computePoolStatus } = await import("../health");
		const now = Date.now();

		const accounts = [
			{ name: "available1", paused: false, rate_limited_until: null },
			{ name: "available2", paused: false, rate_limited_until: null },
			{ name: "paused1", paused: true, rate_limited_until: null },
			{ name: "paused2", paused: true, rate_limited_until: null },
			{
				name: "rate-limited",
				paused: false,
				rate_limited_until: now + 3600000,
			},
		] as any[];

		const status = computePoolStatus(accounts, now);

		expect(status.configured).toBe(5);
		expect(status.paused).toBe(2);
		expect(status.rate_limited).toBe(1);
		expect(status.routable).toBe(2);
		expect(status.next_available_at).toBe(
			new Date(now + 3600000).toISOString(),
		);
	});

	it("handles empty pool", async () => {
		const { computePoolStatus } = await import("../health");
		const status = computePoolStatus([], Date.now());

		expect(status.configured).toBe(0);
		expect(status.paused).toBe(0);
		expect(status.rate_limited).toBe(0);
		expect(status.routable).toBe(0);
		expect(status.next_available_at).toBeNull();
	});

	it("handles all paused accounts", async () => {
		const { computePoolStatus } = await import("../health");
		const accounts = [
			{ name: "paused1", paused: true, rate_limited_until: null },
			{ name: "paused2", paused: true, rate_limited_until: null },
		] as any[];

		const status = computePoolStatus(accounts, Date.now());

		expect(status.configured).toBe(2);
		expect(status.paused).toBe(2);
		expect(status.rate_limited).toBe(0);
		expect(status.routable).toBe(0);
		expect(status.next_available_at).toBeNull();
	});

	it("handles all rate-limited accounts with recovery times", async () => {
		const { computePoolStatus } = await import("../health");
		const now = Date.now();
		const accounts = [
			{
				name: "limited1",
				paused: false,
				rate_limited_until: now + 1800000,
			},
			{
				name: "limited2",
				paused: false,
				rate_limited_until: now + 3600000,
			},
		] as any[];

		const status = computePoolStatus(accounts, now);

		expect(status.configured).toBe(2);
		expect(status.paused).toBe(0);
		expect(status.rate_limited).toBe(2);
		expect(status.routable).toBe(0);
		expect(status.next_available_at).toBe(
			new Date(now + 1800000).toISOString(),
		);
	});

	it("ignores expired rate limits", async () => {
		const { computePoolStatus } = await import("../health");
		const now = Date.now();
		const accounts = [
			{
				name: "expired-limit",
				paused: false,
				rate_limited_until: now - 1000,
			},
			{ name: "available", paused: false, rate_limited_until: null },
		] as any[];

		const status = computePoolStatus(accounts, now);

		expect(status.rate_limited).toBe(0);
		expect(status.routable).toBe(2);
		expect(status.next_available_at).toBeNull();
	});
});

describe("computeHealthStatus three-state logic", () => {
	it("returns ok when runtime healthy and routable accounts exist", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 3,
			paused: 1,
			rate_limited: 0,
			routable: 2,
			next_available_at: null,
		};

		const status = computeHealthStatus(true, pool);
		expect(status).toBe("ok");
	});

	it("returns degraded when routable is 0 but next_available_at is set", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 2,
			paused: 0,
			rate_limited: 2,
			routable: 0,
			next_available_at: new Date(Date.now() + 3600000).toISOString(),
		};

		const status = computeHealthStatus(true, pool);
		expect(status).toBe("degraded");
	});

	it("returns unhealthy when runtime is broken", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 3,
			paused: 0,
			rate_limited: 0,
			routable: 3,
			next_available_at: null,
		};

		const status = computeHealthStatus(false, pool);
		expect(status).toBe("unhealthy");
	});

	it("returns unhealthy when configured is 0", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 0,
			paused: 0,
			rate_limited: 0,
			routable: 0,
			next_available_at: null,
		};

		const status = computeHealthStatus(true, pool);
		expect(status).toBe("unhealthy");
	});

	it("returns unhealthy when routable is 0 with no recovery time", async () => {
		const { computeHealthStatus } = await import("../health");
		const pool = {
			configured: 2,
			paused: 2,
			rate_limited: 0,
			routable: 0,
			next_available_at: null,
		};

		const status = computeHealthStatus(true, pool);
		expect(status).toBe("unhealthy");
	});
});

describe("HTTP status codes", () => {
	it("returns 200 when status is ok", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;
		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;
		const response = await createHealthHandler(
			db,
			config,
		)(new URL("http://localhost/health"));
		expect(response.status).toBe(200);
	});

	it("returns 503 when degraded (no routable, has recovery time)", async () => {
		const db = {
			getAllAccounts: async () => [
				{
					name: "acc1",
					paused: false,
					rate_limited_until: Date.now() + 3600000,
				},
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;
		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;
		const response = await createHealthHandler(
			db,
			config,
		)(new URL("http://localhost/health"));
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.status).toBe("degraded");
		expect(response.status).toBe(503);
	});

	it("returns 503 when unhealthy", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: true, rate_limited_until: null },
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;
		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;
		const response = await createHealthHandler(
			db,
			config,
		)(new URL("http://localhost/health"));
		expect(response.status).toBe(503);
	});

	it("returns 200 when some accounts rate-limited but routable accounts exist", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "available", paused: false, rate_limited_until: null },
				{
					name: "limited",
					paused: false,
					rate_limited_until: Date.now() + 3600000,
				},
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;
		const config = {
			getStrategy: () => "session",
		} as unknown as import("@better-ccflare/config").Config;
		const response = await createHealthHandler(
			db,
			config,
		)(new URL("http://localhost/health"));
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(response.status).toBe(200);
	});
});

describe("?detail=1 parameter", () => {
	it("includes accounts_detail array when detail=1", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
				{ name: "acc2", paused: true, rate_limited_until: null },
				{
					name: "acc3",
					paused: false,
					rate_limited_until: Date.now() + 3600000,
				},
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
			getHealthDetailEnabled: () => true,
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health?detail=1");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, any>;

		expect(body.accounts_detail).toBeDefined();
		expect(body.accounts_detail).toHaveLength(3);
		expect(body.accounts_detail[0]).toEqual({
			name: "acc1",
			status: "available",
			rate_limited_until: null,
		});
		expect(body.accounts_detail[1]).toEqual({
			name: "acc2",
			status: "paused",
			rate_limited_until: null,
		});
		expect(body.accounts_detail[2]).toEqual({
			name: "acc3",
			status: "rate_limited",
			rate_limited_until: expect.any(Number),
		});
	});

	it("omits accounts_detail when detail parameter absent", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
			getHealthDetailEnabled: () => true,
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, unknown>;

		expect(body).not.toHaveProperty("accounts_detail");
	});

	it("shows available status for accounts with expired rate limits", async () => {
		const db = {
			getAllAccounts: async () => [
				{
					name: "expired",
					paused: false,
					rate_limited_until: Date.now() - 1000,
				},
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
			getHealthDetailEnabled: () => true,
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health?detail=1");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, any>;

		expect(body.accounts_detail[0].status).toBe("available");
		expect(body.accounts_detail[0].rate_limited_until).toBeNull();
	});

	it("returns 403 when detail=1 but health_detail_enabled is false", async () => {
		const db = {
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
			],
		} as unknown as import("@better-ccflare/database").DatabaseOperations;

		const config = {
			getStrategy: () => "session",
			getHealthDetailEnabled: () => false,
		} as unknown as import("@better-ccflare/config").Config;

		const handler = createHealthHandler(db, config);
		const url = new URL("http://localhost/health?detail=1");
		const response = await handler(url);
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(403);
		expect(body.error).toBe("detail mode disabled");
	});
});
