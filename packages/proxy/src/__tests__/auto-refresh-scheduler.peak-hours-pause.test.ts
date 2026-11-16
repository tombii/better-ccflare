/**
 * checkPeakHoursPause() pauses/resumes opted-in zai and deepseek accounts,
 * keyed on each provider's own peak window, and only resumes accounts it
 * paused itself (pause_reason = 'peak_hours').
 */
import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import { resetChineseHolidayCache } from "../chinese-holidays";

type Row = {
	id: string;
	name: string;
	paused: number;
	pause_reason: string | null;
};

function makeScheduler(
	rowsByProvider: Record<string, Row[]>,
	{ skipHolidayFetch = true } = {},
) {
	const run = mock(async (_sql: string, _params?: unknown[]) => {});
	const db = {
		query: mock(async (_sql: string, params: unknown[]) => {
			return rowsByProvider[params[0] as string] ?? [];
		}),
		run,
	};
	const scheduler = new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test" },
			refreshInFlight: new Map(),
		} as never,
	);
	// Skip the holiday feed fetch (no network in tests)
	if (skipHolidayFetch) {
		(
			scheduler as unknown as { lastHolidayRefreshAt: number }
		).lastHolidayRefreshAt = Number.MAX_SAFE_INTEGER;
	}
	return { scheduler, run };
}

const tick = (scheduler: AutoRefreshScheduler) =>
	(
		scheduler as unknown as { checkPeakHoursPause(): Promise<void> }
	).checkPeakHoursPause();

describe("checkPeakHoursPause", () => {
	afterEach(() => setSystemTime());

	it("pauses an opted-in deepseek account during DeepSeek peak (Wed 02:00 UTC)", async () => {
		setSystemTime(new Date(Date.UTC(2026, 8, 23, 2, 0)));
		const { scheduler, run } = makeScheduler({
			deepseek: [{ id: "d1", name: "ds", paused: 0, pause_reason: null }],
		});
		await tick(scheduler);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0]).toContain("pause_reason = 'peak_hours'");
		expect(run.mock.calls[0][1]).toEqual(["d1"]);
	});

	it("resumes a peak_hours-paused deepseek account off-peak (Wed 12:00 UTC)", async () => {
		setSystemTime(new Date(Date.UTC(2026, 8, 23, 12, 0)));
		const { scheduler, run } = makeScheduler({
			deepseek: [
				{ id: "d1", name: "ds", paused: 1, pause_reason: "peak_hours" },
			],
		});
		await tick(scheduler);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0]).toContain("paused = 0");
		expect(run.mock.calls[0][1]).toEqual(["d1"]);
	});

	it("does not resume a manually paused deepseek account", async () => {
		setSystemTime(new Date(Date.UTC(2026, 8, 23, 12, 0)));
		const { scheduler, run } = makeScheduler({
			deepseek: [{ id: "d1", name: "ds", paused: 1, pause_reason: "manual" }],
		});
		await tick(scheduler);
		expect(run).not.toHaveBeenCalled();
	});

	it("uses each provider's own window (Wed 02:00 UTC is deepseek peak, not zai peak)", async () => {
		setSystemTime(new Date(Date.UTC(2026, 8, 23, 2, 0)));
		const { scheduler, run } = makeScheduler({
			zai: [{ id: "z1", name: "zai", paused: 0, pause_reason: null }],
		});
		await tick(scheduler);
		expect(run).not.toHaveBeenCalled();
	});

	it("does not wait for a slow TokenHarbor listing refresh", async () => {
		// The listing fetch can take up to 15s per account. Awaiting it would
		// delay the unrelated zai/deepseek pause checks behind it, so the tick
		// starts it and moves on.
		setSystemTime(new Date(Date.UTC(2026, 8, 23, 2, 0)));
		const realFetch = globalThis.fetch;
		let abortFetch: (() => void) | null = null;
		globalThis.fetch = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				abortFetch = () => reject(new Error("aborted for test cleanup"));
				init?.signal?.addEventListener("abort", () => {
					abortFetch?.();
				});
			})) as unknown as typeof fetch;
		try {
			const { scheduler, run } = makeScheduler({
				"anthropic-compatible": [
					{
						id: "th1",
						name: "tokenharbor",
						paused: 0,
						pause_reason: null,
					},
				] as never,
				deepseek: [{ id: "d1", name: "ds", paused: 0, pause_reason: null }],
			});
			// The TokenHarbor refresh query selects more columns than the tick's
			// other queries; give it the shape the refresh loop casts to Account.
			const query = (scheduler as unknown as { db: { query: unknown } }).db
				.query as ReturnType<typeof mock>;
			const originalImpl = query.getMockImplementation();
			query.mockImplementation(async (sql: string, params: unknown[]) => {
				if (params?.[0] === "anthropic-compatible") {
					return [
						{
							id: "th1",
							name: "tokenharbor",
							provider: "anthropic-compatible",
							custom_endpoint: "https://tokenharbor.ai",
							api_key: "test-key",
							peak_hours_pause_enabled: 1,
							model_mappings: null,
							model_fallbacks: null,
						},
					];
				}
				return originalImpl ? originalImpl(sql, params) : [];
			});

			// Resolves promptly even though the listing fetch never settles.
			const result = await Promise.race([
				tick(scheduler).then(() => "done" as const),
				new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 500)),
			]);
			expect(result).toBe("done");
			// The DeepSeek pause still ran.
			expect(run).toHaveBeenCalledTimes(1);
		} finally {
			abortFetch?.();
			globalThis.fetch = realFetch;
		}
	});

	it("waits for the holiday calendar before judging a year with no embedded data", async () => {
		// Wed 2027-03-10 02:00 UTC: weekday peak window, but a feed holiday.
		setSystemTime(new Date(Date.UTC(2027, 2, 10, 2, 0)));
		resetChineseHolidayCache();
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string) => {
			await new Promise((r) => setTimeout(r, 20));
			return String(url).endsWith("/2027.json")
				? Response.json({
						days: [{ name: "x", date: "2027-03-10", isOffDay: true }],
					})
				: new Response("nf", { status: 404 });
		}) as unknown as typeof fetch;
		try {
			const { scheduler, run } = makeScheduler(
				{ deepseek: [{ id: "d1", name: "ds", paused: 0, pause_reason: null }] },
				{ skipHolidayFetch: false },
			);
			await tick(scheduler);
			expect(run).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = realFetch;
			resetChineseHolidayCache();
		}
	});
});
