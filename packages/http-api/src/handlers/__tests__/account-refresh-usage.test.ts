import { describe, expect, it, mock } from "bun:test";
import { registerPollingRestarter } from "@better-ccflare/proxy";
import { createAccountRefreshUsageHandler } from "../accounts";

describe("createAccountRefreshUsageHandler", () => {
	it("allows xAI/Grok accounts to restart usage polling", async () => {
		const accountId = "xai-account";
		const restarter = mock(async (id: string) => id === accountId);
		registerPollingRestarter(`test-xai-refresh-${Date.now()}`, restarter);

		const handler = createAccountRefreshUsageHandler({
			getAccount: async (id: string) =>
				id === accountId
					? {
							id: accountId,
							name: "grok-dogfood",
							provider: "xai",
							access_token: "access-token",
							refresh_token: "refresh-token",
						}
					: null,
		} as never);

		const response = await handler({} as Request, accountId);
		const payload = (await response.json()) as {
			success: boolean;
			pollingRestarted: boolean;
		};

		expect(response.status).toBe(200);
		expect(payload.success).toBe(true);
		expect(payload.pollingRestarted).toBe(true);
		expect(restarter).toHaveBeenCalledWith(accountId);
	});
});
