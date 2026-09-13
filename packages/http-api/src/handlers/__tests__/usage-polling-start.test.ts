import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	registerPollingRestarter,
	unregisterPollingRestarter,
} from "@better-ccflare/proxy";
import { startUsagePollingForNewAccount } from "../usage-polling-start";

const SERVER_ID = "test-usage-polling-start";

describe("startUsagePollingForNewAccount", () => {
	afterEach(() => {
		unregisterPollingRestarter(SERVER_ID);
	});

	it("reports true when a server started polling for the account", async () => {
		const restarter = mock(async (_id: string) => true);
		registerPollingRestarter(SERVER_ID, restarter);

		const started = await startUsagePollingForNewAccount("acc-1", "alpha");

		expect(started).toBe(true);
		expect(restarter).toHaveBeenCalledWith("acc-1");
	});

	it("reports false when no server can poll the provider", async () => {
		registerPollingRestarter(SERVER_ID, async () => false);

		expect(await startUsagePollingForNewAccount("acc-2", "beta")).toBe(false);
	});

	it("never throws when a restarter blows up", async () => {
		registerPollingRestarter(SERVER_ID, async () => {
			throw new Error("restarter exploded");
		});

		expect(await startUsagePollingForNewAccount("acc-3", "gamma")).toBe(false);
	});

	it("reports false when no restarter is registered at all", async () => {
		expect(await startUsagePollingForNewAccount("acc-4", "delta")).toBe(false);
	});
});

describe("startUsagePollingForNewAccount — multiple servers", () => {
	const ids = [`${SERVER_ID}-a`, `${SERVER_ID}-b`];

	beforeEach(() => {
		registerPollingRestarter(ids[0], async () => false);
		registerPollingRestarter(ids[1], async () => true);
	});

	afterEach(() => {
		for (const id of ids) unregisterPollingRestarter(id);
	});

	it("reports true when at least one server started polling", async () => {
		expect(await startUsagePollingForNewAccount("acc-5", "epsilon")).toBe(true);
	});
});
