/**
 * The auto-refresh probe's prompt pool: 500 prompts, each locked for 24 hours
 * after it is sent, claimed exclusively so no two accounts can be seen sending
 * the same text at the same moment.
 *
 * The probe is automated traffic dressed as a real Claude Code CLI request, and
 * the prompt is the part of that disguise a fixed string would ruin. These tests
 * pin the three properties the disguise depends on — the pool is big and varied,
 * a prompt does not come back around for a day, and a claim is exclusive — plus
 * the one thing that has to happen when the pool runs dry: send nothing, and say
 * when the first prompt is free again.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	AUTO_REFRESH_PROMPTS,
	autoRefreshPromptPoolStatus,
	claimAutoRefreshPrompt,
	PROMPT_COOLDOWN_MS,
	releaseAutoRefreshPrompt,
	resetAutoRefreshPromptPoolForTests,
} from "../auto-refresh-prompt-pool";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
	const runCalls: Array<[string, unknown[]]> = [];
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async () => []),
		runCalls,
	};
}

type SendDummyMessageArg = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
};

type TestableScheduler = AutoRefreshScheduler & {
	sendDummyMessage(accountRow: SendDummyMessageArg): Promise<boolean>;
	consecutiveFailures: Map<string, number>;
};

function makeAccountRow(
	overrides: Partial<SendDummyMessageArg> = {},
): SendDummyMessageArg {
	return {
		id: "acc-1",
		name: "account-one",
		provider: "anthropic",
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...overrides,
	};
}

async function makeScheduler(
	db: ReturnType<typeof makeDb>,
): Promise<TestableScheduler> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			internalProbeSecret: "secret",
			// A successful Anthropic probe goes on to record a usage snapshot, so
			// the real context always has this. Leaving it out turns the success
			// path into an exception and hides it as a counted failure.
			dbOps: { recordUsageSnapshot: mock(async () => {}) },
		} as never,
	) as TestableScheduler;
}

/** Every prompt body the scheduler handed to fetch, in order. */
function captureSentPrompts(): string[] {
	const sent: string[] = [];
	globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		const content = body?.messages?.[0]?.content;
		if (typeof content === "string") sent.push(content);
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return sent;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = realFetch;
	resetAutoRefreshPromptPoolForTests();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	// The pool is module state, and `bun test` shares one process across files.
	// A drained pool left behind here would make every later file's dummy-message
	// call refuse to send.
	resetAutoRefreshPromptPoolForTests();
});

// ── the pool itself ───────────────────────────────────────────────────────────

describe("auto-refresh prompt pool", () => {
	it("carries 500 distinct prompts, all short enough to be cheap", () => {
		expect(AUTO_REFRESH_PROMPTS).toHaveLength(500);
		// A repeated string is the fingerprint the pool exists to avoid, so the
		// count only means something if every entry is different.
		expect(new Set(AUTO_REFRESH_PROMPTS).size).toBe(500);
		for (const prompt of AUTO_REFRESH_PROMPTS) {
			expect(prompt.trim()).not.toBe("");
			// Input is what the probe pays for; the reply is capped at ten tokens.
			expect(prompt.length).toBeLessThanOrEqual(80);
		}
	});

	it("still contains the original five", () => {
		for (const original of [
			"Write a hello world program in Python",
			"What is 2+2?",
			"Tell me a programmer joke",
			"What is the capital of France?",
			"Explain recursion in one sentence",
		]) {
			expect(AUTO_REFRESH_PROMPTS).toContain(original);
		}
	});

	it("never hands the same prompt out twice inside 24 hours", () => {
		const now = 1_700_000_000_000;
		const seen = new Set<number>();

		for (let i = 0; i < AUTO_REFRESH_PROMPTS.length; i++) {
			const claim = claimAutoRefreshPrompt(now);
			expect(claim.ok).toBe(true);
			if (!claim.ok) return;
			expect(seen.has(claim.index)).toBe(false);
			seen.add(claim.index);
		}

		expect(seen.size).toBe(500);
	});

	it("reports when the first prompt frees up once everything is locked", () => {
		const now = 1_700_000_000_000;
		for (let i = 0; i < AUTO_REFRESH_PROMPTS.length; i++) {
			claimAutoRefreshPrompt(now);
		}

		const dry = claimAutoRefreshPrompt(now);
		expect(dry.ok).toBe(false);
		if (dry.ok) return;
		expect(dry.retryAt).toBe(now + PROMPT_COOLDOWN_MS);
		expect(autoRefreshPromptPoolStatus(now)).toEqual({
			free: 0,
			total: 500,
			retryAt: now + PROMPT_COOLDOWN_MS,
		});
	});

	it("names the earliest release, not the latest", () => {
		const first = 1_700_000_000_000;
		// Drain the pool one prompt per minute, so the 500 locks expire at 500
		// different times. The answer must be about the one that comes back first.
		for (let i = 0; i < AUTO_REFRESH_PROMPTS.length; i++) {
			claimAutoRefreshPrompt(first + i * 60_000);
		}
		const last = first + 499 * 60_000;

		const dry = claimAutoRefreshPrompt(last);
		expect(dry.ok).toBe(false);
		if (dry.ok) return;
		expect(dry.retryAt).toBe(first + PROMPT_COOLDOWN_MS);
	});

	it("puts a prompt back in circulation after its day is up", () => {
		const now = 1_700_000_000_000;
		for (let i = 0; i < AUTO_REFRESH_PROMPTS.length; i++) {
			claimAutoRefreshPrompt(now);
		}
		expect(claimAutoRefreshPrompt(now).ok).toBe(false);

		// One millisecond before, still nothing; on the mark, the whole pool is back
		// because it was drained in a single instant.
		expect(claimAutoRefreshPrompt(now + PROMPT_COOLDOWN_MS - 1).ok).toBe(false);
		expect(claimAutoRefreshPrompt(now + PROMPT_COOLDOWN_MS).ok).toBe(true);
	});

	it("gives the second caller of the same instant a different prompt", () => {
		const now = 1_700_000_000_000;
		const first = claimAutoRefreshPrompt(now);
		const second = claimAutoRefreshPrompt(now);

		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		// The claim marks its choice before it returns, with no await in between,
		// so "first one wins" is structural rather than lucky.
		expect(second.index).not.toBe(first.index);
		expect(second.prompt).not.toBe(first.prompt);
	});

	it("counts down as prompts are claimed", () => {
		const now = 1_700_000_000_000;
		expect(autoRefreshPromptPoolStatus(now)).toEqual({
			free: 500,
			total: 500,
			retryAt: null,
		});

		claimAutoRefreshPrompt(now);
		claimAutoRefreshPrompt(now);

		expect(autoRefreshPromptPoolStatus(now)).toEqual({
			free: 498,
			total: 500,
			retryAt: now + PROMPT_COOLDOWN_MS,
		});
	});
});

// ── the scheduler drawing from it ─────────────────────────────────────────────

describe("AutoRefreshScheduler.sendDummyMessage — drawing from the pool", () => {
	it("sends a prompt that came from the pool", async () => {
		const sent = captureSentPrompts();
		const scheduler = await makeScheduler(makeDb());

		expect(await scheduler.sendDummyMessage(makeAccountRow())).toBe(true);

		expect(sent).toHaveLength(1);
		expect(AUTO_REFRESH_PROMPTS).toContain(sent[0]);
	});

	it("never sends two accounts the same text in one pass", async () => {
		const sent = captureSentPrompts();
		const scheduler = await makeScheduler(makeDb());

		await scheduler.sendDummyMessage(makeAccountRow({ id: "acc-1" }));
		await scheduler.sendDummyMessage(
			makeAccountRow({ id: "acc-2", name: "account-two" }),
		);

		expect(sent).toHaveLength(2);
		expect(sent[0]).not.toBe(sent[1]);
	});

	it("sends nothing at all when every prompt is on cooldown", async () => {
		for (let i = 0; i < AUTO_REFRESH_PROMPTS.length; i++) {
			claimAutoRefreshPrompt();
		}
		const sent = captureSentPrompts();
		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		expect(await scheduler.sendDummyMessage(accountRow)).toBe(false);

		expect(sent).toHaveLength(0);
		// Holding off is not the account misbehaving: it must not count toward the
		// consecutive-failure pause, and it must not touch the account's row.
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();
		expect(db.runCalls).toHaveLength(0);
	});
});

// ── giving a prompt back ──────────────────────────────────────────────────────

describe("auto-refresh prompt pool — releasing an unspent claim", () => {
	it("puts the prompt straight back, without waiting out the day", () => {
		const now = 1_700_000_000_000;
		const claim = claimAutoRefreshPrompt(now);
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		expect(autoRefreshPromptPoolStatus(now).free).toBe(499);

		releaseAutoRefreshPrompt(claim.index);

		// The lock exists to stop the same text being *sent* twice in a day. A
		// claim that never became a request is not a lock, it is a leak.
		expect(autoRefreshPromptPoolStatus(now)).toEqual({
			free: 500,
			total: 500,
			retryAt: null,
		});
	});

	it("hands the released prompt out again in the same instant", () => {
		const now = 1_700_000_000_000;
		// Drain everything but one, then release that one: the next claim can only
		// be the prompt that came back.
		for (let i = 0; i < AUTO_REFRESH_PROMPTS.length; i++) {
			claimAutoRefreshPrompt(now);
		}
		expect(claimAutoRefreshPrompt(now).ok).toBe(false);

		releaseAutoRefreshPrompt(7);
		const again = claimAutoRefreshPrompt(now);

		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.index).toBe(7);
	});

	it("frees only the prompt it names", () => {
		const now = 1_700_000_000_000;
		const first = claimAutoRefreshPrompt(now);
		const second = claimAutoRefreshPrompt(now);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;

		releaseAutoRefreshPrompt(first.index);

		expect(autoRefreshPromptPoolStatus(now).free).toBe(499);
		expect(autoRefreshPromptPoolStatus(now).retryAt).toBe(
			now + PROMPT_COOLDOWN_MS,
		);
	});

	it("does nothing when the prompt is already free", () => {
		const now = 1_700_000_000_000;
		releaseAutoRefreshPrompt(0);
		releaseAutoRefreshPrompt(0);

		expect(autoRefreshPromptPoolStatus(now)).toEqual({
			free: 500,
			total: 500,
			retryAt: null,
		});
	});
});

describe("AutoRefreshScheduler.sendDummyMessage — returning what it did not spend", () => {
	it("gives the prompt back when there is no provider to send through", async () => {
		const sent = captureSentPrompts();
		const scheduler = await makeScheduler(makeDb());

		expect(
			await scheduler.sendDummyMessage(
				makeAccountRow({ provider: "not-a-real-provider" }),
			),
		).toBe(false);

		expect(sent).toHaveLength(0);
		expect(autoRefreshPromptPoolStatus().free).toBe(
			AUTO_REFRESH_PROMPTS.length,
		);
	});

	it("gives the prompt back when the throw came before the request", async () => {
		const sent = captureSentPrompts();
		const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
		// No runtime on the context: building the endpoint URL throws, which lands
		// in the catch without a single byte having left the process.
		const scheduler = new AutoRefreshScheduler(
			makeDb() as never,
			{
				refreshInFlight: new Map(),
			} as never,
		) as unknown as {
			sendDummyMessage(
				row: ReturnType<typeof makeAccountRow>,
			): Promise<boolean>;
		};

		expect(await scheduler.sendDummyMessage(makeAccountRow())).toBe(false);

		expect(sent).toHaveLength(0);
		expect(autoRefreshPromptPoolStatus().free).toBe(
			AUTO_REFRESH_PROMPTS.length,
		);
	});

	it("keeps the prompt when the provider answered, even with an error", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("overloaded", { status: 529 });
		}) as unknown as typeof fetch;
		const scheduler = await makeScheduler(makeDb());

		expect(await scheduler.sendDummyMessage(makeAccountRow())).toBe(false);

		// The text was sent. Handing it back would let the same prompt go out
		// twice inside a minute, which is the one thing the cooldown is for.
		expect(autoRefreshPromptPoolStatus().free).toBe(
			AUTO_REFRESH_PROMPTS.length - 1,
		);
	});
});
