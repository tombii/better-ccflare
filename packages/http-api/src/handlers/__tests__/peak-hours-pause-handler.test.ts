import { describe, expect, it, mock } from "bun:test";
import { createAccountPeakHoursPauseHandler } from "../accounts";

function makeHandler(provider: string) {
	const setPeakHoursPauseEnabled = mock(async () => {});
	const dbOps = {
		getAdapter: () => ({
			get: async () => ({ name: "acct", provider }),
			run: async () => {},
		}),
		setPeakHoursPauseEnabled,
	};
	const handler = createAccountPeakHoursPauseHandler(dbOps as never);
	const call = () =>
		handler(
			new Request("http://x/api/accounts/a1/peak-hours-pause", {
				method: "POST",
				body: JSON.stringify({ enabled: 1 }),
			}),
			"a1",
		);
	return { call, setPeakHoursPauseEnabled };
}

describe("peak-hours-pause handler provider gate", () => {
	it("accepts deepseek accounts", async () => {
		const { call, setPeakHoursPauseEnabled } = makeHandler("deepseek");
		const res = await call();
		expect(res.status).toBe(200);
		expect(setPeakHoursPauseEnabled).toHaveBeenCalledWith("a1", true);
	});

	it("accepts zai accounts", async () => {
		expect((await makeHandler("zai").call()).status).toBe(200);
	});

	it("rejects other providers", async () => {
		const { call, setPeakHoursPauseEnabled } = makeHandler("openai-compatible");
		expect((await call()).status).toBe(400);
		expect(setPeakHoursPauseEnabled).not.toHaveBeenCalled();
	});
});
