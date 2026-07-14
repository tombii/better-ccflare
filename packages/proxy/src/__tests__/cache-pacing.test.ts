import { afterEach, describe, expect, test } from "bun:test";
import {
	acquireCachePacing,
	CACHE_PACING_MS_ENV,
	CODEX_PACING_BYPASS_PERCENT_ENV,
	finishPacing,
	getCachePacingRouteStats,
	getCachePacingStats,
	isCodexPacingBypassCandidate,
	observeCachePacing,
	readCachePacingMs,
	readCodexPacingBypassPercent,
	recordCachePacingRoute,
	resetCachePacing,
} from "../cache-pacing";

afterEach(() => {
	resetCachePacing();
	delete process.env[CACHE_PACING_MS_ENV];
	delete process.env[CODEX_PACING_BYPASS_PERCENT_ENV];
});

function sseResponse(chunks: string[], delayMs = 0): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				if (delayMs > 0) {
					await new Promise((r) => setTimeout(r, delayMs));
				}
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("readCachePacingMs", () => {
	test("disabled by default, parses overrides, rejects nonsense", () => {
		expect(readCachePacingMs()).toBe(0);
		process.env[CACHE_PACING_MS_ENV] = "15000";
		expect(readCachePacingMs()).toBe(15_000);
		process.env[CACHE_PACING_MS_ENV] = "junk";
		expect(readCachePacingMs()).toBe(0);
	});
});

describe("Codex pacing bypass cohort", () => {
	test("defaults off, parses strictly, and clamps to 100", () => {
		expect(readCodexPacingBypassPercent()).toBe(0);
		for (const invalid of ["junk", "1e2", "-1", "1.5"]) {
			process.env[CODEX_PACING_BYPASS_PERCENT_ENV] = invalid;
			expect(readCodexPacingBypassPercent()).toBe(0);
		}
		process.env[CODEX_PACING_BYPASS_PERCENT_ENV] = "17";
		expect(readCodexPacingBypassPercent()).toBe(17);
		process.env[CODEX_PACING_BYPASS_PERCENT_ENV] = "999";
		expect(readCodexPacingBypassPercent()).toBe(100);
	});

	test("assignment is deterministic by session and missing identity stays control", () => {
		process.env[CACHE_PACING_MS_ENV] = "15000";
		expect(isCodexPacingBypassCandidate(null, 100)).toBe(false);
		expect(isCodexPacingBypassCandidate("session-a", 0)).toBe(false);
		expect(isCodexPacingBypassCandidate("session-a", 100)).toBe(true);
		const first = isCodexPacingBypassCandidate("session-stable", 37);
		for (let i = 0; i < 20; i++) {
			expect(isCodexPacingBypassCandidate("session-stable", 37)).toBe(first);
		}
	});

	test("records treatment, control, and crossovers separately", () => {
		const codex = {
			accountId: "pro",
			accountName: "pro-primary",
			provider: "codex",
		};
		const anthropic = {
			accountId: "max",
			accountName: "max-secondary",
			provider: "anthropic",
		};
		recordCachePacingRoute(null, codex, { candidate: true, bypassed: true });
		const control = {
			key: "k",
			role: "leader" as const,
			waitedMs: 0,
			releaseReason: null,
			slot: null,
		};
		recordCachePacingRoute(control, codex, {
			candidate: true,
			bypassed: false,
		});
		// The ordinary non-treatment population is also part of control.
		recordCachePacingRoute(control, codex, {
			candidate: true,
			bypassed: false,
		});
		recordCachePacingRoute(null, anthropic, {
			candidate: true,
			bypassed: true,
		});

		const routes = getCachePacingRouteStats();
		expect(routes.pro.canaryBypassServed).toBe(1);
		expect(routes.pro.canaryControlServed).toBe(2);
		expect(routes.pro.canaryCrossovers).toBe(0);
		expect(routes.max.canaryCrossovers).toBe(1);
		expect(routes.max.canaryBypassServed).toBe(0);
	});
});

describe("acquireCachePacing", () => {
	test("returns null when disabled or session missing", async () => {
		expect(
			await acquireCachePacing({ sessionKey: "s1", model: "m" }),
		).toBeNull();
		process.env[CACHE_PACING_MS_ENV] = "1000";
		expect(
			await acquireCachePacing({ sessionKey: null, model: "m" }),
		).toBeNull();
	});

	test("first request leads immediately, follower waits for first body chunk", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s1", model: "m" });
		expect(leader).not.toBeNull();

		let followerReleased = false;
		const followerPromise = acquireCachePacing({
			sessionKey: "s1",
			model: "m",
		}).then((slot) => {
			followerReleased = true;
			return slot;
		});

		await new Promise((r) => setTimeout(r, 30));
		expect(followerReleased).toBe(false);

		// Leader's response starts streaming: first chunk releases the follower.
		const wrapped = finishPacing(leader, sseResponse(["event: a\n\n"], 10));
		await wrapped.text();

		const followerSlot = await followerPromise;
		expect(followerReleased).toBe(true);
		expect(followerSlot).toBeNull();
	});

	test("wrapped body passes through byte-identical", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s2", model: "m" });
		const wrapped = finishPacing(leader, sseResponse(["hello ", "world"], 1));
		expect(await wrapped.text()).toBe("hello world");
		expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
	});

	test("abandon releases followers immediately", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s3", model: "m" });
		const start = Date.now();
		const followerPromise = acquireCachePacing({
			sessionKey: "s3",
			model: "m",
		});
		leader?.abandon();
		await followerPromise;
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	test("non-ok leader response abandons instead of wrapping", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s4", model: "m" });
		const followerPromise = acquireCachePacing({
			sessionKey: "s4",
			model: "m",
		});
		const errorResponse = new Response("nope", { status: 503 });
		const finished = finishPacing(leader, errorResponse);
		expect(finished.status).toBe(503);
		await followerPromise; // resolves promptly because abandon fired
	});

	test("follower releases at the cap when the leader never streams", async () => {
		process.env[CACHE_PACING_MS_ENV] = "50";
		await acquireCachePacing({ sessionKey: "s5", model: "m" });
		const start = Date.now();
		await acquireCachePacing({ sessionKey: "s5", model: "m" });
		const held = Date.now() - start;
		expect(held).toBeGreaterThanOrEqual(40);
		expect(held).toBeLessThan(2_000);
	});

	test("different sessions and models do not block each other", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const start = Date.now();
		await acquireCachePacing({ sessionKey: "s6", model: "m1" });
		await acquireCachePacing({ sessionKey: "s6", model: "m2" });
		await acquireCachePacing({ sessionKey: "s7", model: "m1" });
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	test("stale leader is replaced instead of waited on", async () => {
		process.env[CACHE_PACING_MS_ENV] = "100";
		let clock = 1_000_000;
		const now = () => clock;
		const first = await acquireCachePacing({
			sessionKey: "s8",
			model: "m",
			now,
		});
		expect(first).not.toBeNull();
		// Advance beyond 2x the cap: the dead leader must not hold newcomers.
		clock += 500;
		const start = Date.now();
		const second = await acquireCachePacing({
			sessionKey: "s8",
			model: "m",
			now,
		});
		expect(second).not.toBeNull();
		expect(Date.now() - start).toBeLessThan(1_000);
		expect(getCachePacingStats().other?.staleLeadersReplaced).toBe(1);
	});
});

describe("getCachePacingStats", () => {
	test("attributes leaders and leader-released followers per family", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({
			sessionKey: "st1",
			model: "claude-opus-4-8",
		});
		const followerPromise = acquireCachePacing({
			sessionKey: "st1",
			model: "claude-opus-4-8",
		});
		await new Promise((r) => setTimeout(r, 10));
		const wrapped = finishPacing(leader, sseResponse(["event: a\n\n"], 1));
		await wrapped.text();
		await followerPromise;

		const stats = getCachePacingStats();
		expect(stats.anthropic.leaders).toBe(1);
		expect(stats.anthropic.followersHeld).toBe(1);
		expect(stats.anthropic.followersReleasedByLeader).toBe(1);
		expect(stats.anthropic.followersReleasedByCap).toBe(0);
		expect(stats.anthropic.followerWaitMsTotal).toBeGreaterThanOrEqual(0);
		expect(stats.codex).toBeUndefined();
	});

	test("attributes cap releases and abandons, families separated", async () => {
		process.env[CACHE_PACING_MS_ENV] = "30";
		await acquireCachePacing({ sessionKey: "st2", model: "gpt-5.6-sol" });
		// Leader never streams: the follower must release at the cap.
		await acquireCachePacing({ sessionKey: "st2", model: "gpt-5.6-sol" });
		const abandoned = await acquireCachePacing({
			sessionKey: "st3",
			model: "gpt-5.6-sol",
		});
		abandoned?.abandon();

		const stats = getCachePacingStats();
		expect(stats.openai.leaders).toBe(2);
		expect(stats.openai.followersHeld).toBe(1);
		expect(stats.openai.followersReleasedByCap).toBe(1);
		expect(stats.openai.followersReleasedByLeader).toBe(0);
		expect(stats.openai.leadersAbandoned).toBe(1);
		expect(stats.openai.followerWaitMsMax).toBeGreaterThanOrEqual(20);
		expect(stats.anthropic).toBeUndefined();
	});

	test("attributes observations only after the serving route is known", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await observeCachePacing({
			sessionKey: "shadow",
			model: "claude-opus-4-8",
		});
		const followerPromise = observeCachePacing({
			sessionKey: "shadow",
			model: "claude-opus-4-8",
		});
		await new Promise((r) => setTimeout(r, 10));
		const wrapped = finishPacing(
			leader?.slot ?? null,
			sseResponse(["event: a\n\n"], 1),
		);
		await wrapped.text();
		const follower = await followerPromise;

		// No selection-time attribution: only successful routes are counted.
		expect(getCachePacingRouteStats()).toEqual({});
		recordCachePacingRoute(leader, {
			accountId: "acct-a",
			accountName: "failed-first-account",
			provider: "anthropic",
		});
		recordCachePacingRoute(follower, {
			accountId: "acct-pro",
			accountName: "pro-primary",
			provider: "codex",
		});

		const routes = getCachePacingRouteStats();
		expect(routes["acct-a"].leaders).toBe(1);
		expect(routes["acct-a"].requestsServed).toBe(1);
		expect(routes["acct-pro"].followersHeld).toBe(1);
		expect(routes["acct-pro"].followersReleasedByLeader).toBe(1);
		expect(routes["acct-pro"].followerWaitMsTotal).toBeGreaterThanOrEqual(0);
		expect(routes["acct-pro"].provider).toBe("codex");
	});

	// Route counters are the Codex-bypass counterfactual: a served Codex
	// follower's ordinary wait metrics are exactly what bypass would avoid.
	test("preserves openai family compatibility while routes carry actual provider", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const observation = await observeCachePacing({
			sessionKey: "codex",
			model: "gpt-5.6-sol",
		});
		recordCachePacingRoute(observation, {
			accountId: "acct-pro",
			accountName: "pro-primary",
			provider: "codex",
		});
		expect(getCachePacingStats().openai.leaders).toBe(1);
		expect(getCachePacingRouteStats()["acct-pro"].provider).toBe("codex");
		observation?.slot?.abandon();
	});
	test("reset clears family and route stats", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		await acquireCachePacing({
			sessionKey: "st4",
			model: "claude-opus-4-8",
			target: {
				accountId: "acct",
				accountName: "account",
				provider: "anthropic",
			},
		});
		resetCachePacing();
		expect(getCachePacingStats()).toEqual({});
		expect(getCachePacingRouteStats()).toEqual({});
	});
});
