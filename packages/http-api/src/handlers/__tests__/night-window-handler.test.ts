import { describe, expect, it, mock } from "bun:test";
import { createAccountNightWindowHandler } from "../accounts";

function makeHandler(provider = "sailresearch") {
	const state = { enabled: false };
	const setNightWindowEnabled = mock(async (_id: string, enabled: boolean) => {
		state.enabled = enabled;
	});
	const dbOps = {
		getAdapter: () => ({
			get: async () => ({ name: "acct", provider }),
			run: async () => {},
		}),
		setNightWindowEnabled,
		getAccount: async (id: string) => ({
			id,
			name: "acct",
			provider,
			night_window_enabled: state.enabled,
		}),
	};
	const handler = createAccountNightWindowHandler(dbOps as never);
	const call = (body: string, accountId = "a1") =>
		handler(
			new Request(`http://x/api/accounts/${accountId}/night-window`, {
				method: "POST",
				body,
			}),
			accountId,
		);
	return { call, setNightWindowEnabled, state };
}

describe("night-window handler", () => {
	it("enables the flag and reflects it in the response", async () => {
		const { call, setNightWindowEnabled } = makeHandler();
		const res = await call(JSON.stringify({ enabled: true }));
		expect(res.status).toBe(200);
		expect(setNightWindowEnabled).toHaveBeenCalledWith("a1", true);
		const body = (await res.json()) as {
			nightWindowEnabled: boolean;
			account: { night_window_enabled: boolean };
		};
		expect(body.nightWindowEnabled).toBe(true);
		expect(body.account.night_window_enabled).toBe(true);
	});

	it("disables the flag", async () => {
		const { call, setNightWindowEnabled, state } = makeHandler();
		state.enabled = true;
		const res = await call(JSON.stringify({ enabled: false }));
		expect(res.status).toBe(200);
		expect(setNightWindowEnabled).toHaveBeenCalledWith("a1", false);
		const body = (await res.json()) as {
			nightWindowEnabled: boolean;
			account: { night_window_enabled: boolean };
		};
		expect(body.nightWindowEnabled).toBe(false);
		expect(body.account.night_window_enabled).toBe(false);
	});

	it("is provider-agnostic (no sailresearch-only gate)", async () => {
		const { call } = makeHandler("anthropic");
		expect((await call(JSON.stringify({ enabled: true }))).status).toBe(200);
	});

	it.each([
		["missing enabled", JSON.stringify({})],
		["string enabled", JSON.stringify({ enabled: "true" })],
		["numeric enabled", JSON.stringify({ enabled: 1 })],
		["null body", "null"],
	])("rejects invalid body: %s", async (_label, body) => {
		const { call, setNightWindowEnabled } = makeHandler();
		const res = await call(body);
		expect(res.status).toBe(400);
		expect(setNightWindowEnabled).not.toHaveBeenCalled();
	});

	it("returns 404 for an unknown account", async () => {
		const setNightWindowEnabled = mock(async () => {});
		const dbOps = {
			getAdapter: () => ({ get: async () => null, run: async () => {} }),
			setNightWindowEnabled,
			getAccount: async () => null,
		};
		const handler = createAccountNightWindowHandler(dbOps as never);
		const res = await handler(
			new Request("http://x/api/accounts/missing/night-window", {
				method: "POST",
				body: JSON.stringify({ enabled: true }),
			}),
			"missing",
		);
		expect(res.status).toBe(404);
		expect(setNightWindowEnabled).not.toHaveBeenCalled();
	});
});
