import { describe, expect, it } from "bun:test";
import type { UsageSnapshotRow } from "@better-ccflare/types";
import { createUsageHistoryHandler } from "../usage-history";

// Captures the opts passed to getUsageHistory so we can assert filter forwarding.
function makeContext(rows: UsageSnapshotRow[]) {
	const calls: Array<{
		accountId: string;
		windowKey?: string;
		since?: number;
	}> = [];
	const context = {
		dbOps: {
			getUsageHistory: async (opts: {
				accountId: string;
				windowKey?: string;
				since?: number;
			}) => {
				calls.push(opts);
				return rows;
			},
		},
	} as unknown as import("../../types").APIContext;
	return { context, calls };
}

describe("createUsageHistoryHandler", () => {
	it("400s when account is missing", async () => {
		const { context } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams(""));
		expect(res.status).toBe(400);
	});

	it("groups rows by window and includes a prediction", async () => {
		const H = 60 * 60 * 1000;
		const rows: UsageSnapshotRow[] = [0, 1, 2, 3].map((h) => ({
			accountId: "acc1",
			timestamp: h * H,
			windowKey: "five_hour",
			utilization: 10 * h + 10,
			resetsAt: 20 * H,
		}));
		const { context } = makeContext(rows);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1&range=7d"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accountId: string;
			range: string;
			windows: {
				window: string;
				points: unknown[];
				prediction: { state: string };
			}[];
		};
		expect(body.accountId).toBe("acc1");
		expect(body.windows).toHaveLength(1);
		expect(body.windows[0].window).toBe("five_hour");
		expect(body.windows[0].points).toHaveLength(4);
		expect(body.windows[0].prediction.state).toBe("rising");
	});

	it("echoes the normalized range for an unknown value", async () => {
		const { context } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1&range=bogus"));
		const body = (await res.json()) as { range: string };
		expect(body.range).toBe("24h"); // unknown → getRangeConfig falls back to 24h
	});

	it("forwards the window filter to getUsageHistory", async () => {
		const { context, calls } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		await handler(new URLSearchParams("account=acc1&window=seven_day_opus"));
		expect(calls[0].accountId).toBe("acc1");
		expect(calls[0].windowKey).toBe("seven_day_opus");
	});

	it("returns an empty windows array when there are no rows", async () => {
		const { context } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1"));
		const body = (await res.json()) as { windows: unknown[] };
		expect(body.windows).toEqual([]);
	});
});
