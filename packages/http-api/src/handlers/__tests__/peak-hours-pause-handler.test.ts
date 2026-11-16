import { describe, expect, it, mock } from "bun:test";
import { createAccountPeakHoursPauseHandler } from "../accounts";

function makeHandler(
	provider: string,
	options: { customEndpoint?: string | null } = {},
) {
	const setPeakHoursPauseEnabled = mock(async () => {});
	const dbOps = {
		getAdapter: () => ({
			// The TokenHarbor gate does a second `db.get` for the endpoint
			// columns, so the mock answers by query shape rather than always
			// returning the same row.
			get: async (sql: string) =>
				sql.includes("custom_endpoint")
					? {
							custom_endpoint: options.customEndpoint ?? null,
							api_key: null,
							model_mappings: null,
						}
					: { name: "acct", provider },
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

	// anthropic-compatible is a shared provider string: only the TokenHarbor
	// host has a peak concept, so the endpoint decides, not the provider.
	it("accepts anthropic-compatible accounts on the TokenHarbor endpoint", async () => {
		const { call, setPeakHoursPauseEnabled } = makeHandler(
			"anthropic-compatible",
			{ customEndpoint: "https://tokenharbor.ai" },
		);
		const res = await call();
		expect(res.status).toBe(200);
		expect(setPeakHoursPauseEnabled).toHaveBeenCalledWith("a1", true);
	});

	it("rejects anthropic-compatible accounts on any other endpoint", async () => {
		const { call, setPeakHoursPauseEnabled } = makeHandler(
			"anthropic-compatible",
			{ customEndpoint: "https://example.com" },
		);
		const res = await call();
		expect(res.status).toBe(400);
		expect(setPeakHoursPauseEnabled).not.toHaveBeenCalled();
	});
});
