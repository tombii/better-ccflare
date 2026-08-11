import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	clearAllPendingRotationsForTests,
	clearPendingRotation,
	flushPendingRotation,
	getPendingRotation,
	type PendingRotationDbOps,
	recordPendingRotation,
} from "../pending-rotation-registry";

function makeDbOps(overrides: Partial<PendingRotationDbOps> = {}) {
	return {
		updateAccountTokensIfRefreshTokenMatches: mock(async () => true),
		updateAccountTokensIfRefreshTokenAbsent: mock(async () => true),
		...overrides,
	} satisfies PendingRotationDbOps;
}

beforeEach(() => {
	clearAllPendingRotationsForTests();
});

describe("recordPendingRotation / getPendingRotation", () => {
	it("roundtrips a recorded rotation", () => {
		recordPendingRotation("acc-1", {
			accessToken: "access-1",
			expiresAt: 12345,
			refreshToken: "refresh-1",
			attemptedRefreshToken: "old-refresh-1",
		});

		const entry = getPendingRotation("acc-1");
		expect(entry).toBeDefined();
		expect(entry?.accessToken).toBe("access-1");
		expect(entry?.expiresAt).toBe(12345);
		expect(entry?.refreshToken).toBe("refresh-1");
		expect(entry?.attemptedRefreshToken).toBe("old-refresh-1");
		expect(typeof entry?.recordedAt).toBe("number");
	});

	it("returns undefined when no entry exists for the account", () => {
		expect(getPendingRotation("missing-acc")).toBeUndefined();
	});

	it("replaces an existing entry for the same account id", () => {
		recordPendingRotation("acc-1", {
			accessToken: "access-1",
			expiresAt: 1,
			attemptedRefreshToken: "old-1",
		});
		recordPendingRotation("acc-1", {
			accessToken: "access-2",
			expiresAt: 2,
			attemptedRefreshToken: "old-2",
		});

		const entry = getPendingRotation("acc-1");
		expect(entry?.accessToken).toBe("access-2");
		expect(entry?.expiresAt).toBe(2);
		expect(entry?.attemptedRefreshToken).toBe("old-2");
	});
});

describe("clearPendingRotation", () => {
	it("removes the entry for the given account", () => {
		recordPendingRotation("acc-1", {
			accessToken: "access-1",
			expiresAt: 1,
			attemptedRefreshToken: "old-1",
		});
		clearPendingRotation("acc-1");
		expect(getPendingRotation("acc-1")).toBeUndefined();
	});

	it("is a no-op when there is no entry for the account", () => {
		expect(() => clearPendingRotation("no-such-acc")).not.toThrow();
	});
});

describe("flushPendingRotation", () => {
	it('returns "none" when there is no pending entry for the account', async () => {
		const dbOps = makeDbOps();
		const outcome = await flushPendingRotation("acc-1", dbOps);
		expect(outcome).toBe("none");
		expect(
			dbOps.updateAccountTokensIfRefreshTokenMatches,
		).not.toHaveBeenCalled();
		expect(
			dbOps.updateAccountTokensIfRefreshTokenAbsent,
		).not.toHaveBeenCalled();
	});

	it('returns "persisted" and clears the entry when attemptedRefreshToken is truthy and CAS lands', async () => {
		const dbOps = makeDbOps({
			updateAccountTokensIfRefreshTokenMatches: mock(async () => true),
		});
		recordPendingRotation("acc-1", {
			accessToken: "access-1",
			expiresAt: 999,
			refreshToken: "refresh-new",
			attemptedRefreshToken: "refresh-old",
		});

		const outcome = await flushPendingRotation("acc-1", dbOps);

		expect(outcome).toBe("persisted");
		expect(dbOps.updateAccountTokensIfRefreshTokenMatches).toHaveBeenCalledWith(
			"acc-1",
			"refresh-old",
			"access-1",
			999,
			"refresh-new",
		);
		expect(
			dbOps.updateAccountTokensIfRefreshTokenAbsent,
		).not.toHaveBeenCalled();
		expect(getPendingRotation("acc-1")).toBeUndefined();
	});

	it('uses updateAccountTokensIfRefreshTokenAbsent when attemptedRefreshToken is empty, and returns "persisted"', async () => {
		const dbOps = makeDbOps({
			updateAccountTokensIfRefreshTokenAbsent: mock(async () => true),
		});
		recordPendingRotation("acc-1", {
			accessToken: "access-1",
			expiresAt: 999,
			refreshToken: "refresh-new",
			attemptedRefreshToken: "",
		});

		const outcome = await flushPendingRotation("acc-1", dbOps);

		expect(outcome).toBe("persisted");
		expect(dbOps.updateAccountTokensIfRefreshTokenAbsent).toHaveBeenCalledWith(
			"acc-1",
			"access-1",
			999,
			"refresh-new",
		);
		expect(
			dbOps.updateAccountTokensIfRefreshTokenMatches,
		).not.toHaveBeenCalled();
		expect(getPendingRotation("acc-1")).toBeUndefined();
	});

	it('returns "superseded" and clears the entry when the CAS matches 0 rows', async () => {
		const dbOps = makeDbOps({
			updateAccountTokensIfRefreshTokenMatches: mock(async () => false),
		});
		recordPendingRotation("acc-1", {
			accessToken: "access-1",
			expiresAt: 999,
			attemptedRefreshToken: "refresh-old",
		});

		const outcome = await flushPendingRotation("acc-1", dbOps);

		expect(outcome).toBe("superseded");
		expect(getPendingRotation("acc-1")).toBeUndefined();
	});

	it('returns "failed" and keeps the entry when the write throws', async () => {
		const dbOps = makeDbOps({
			updateAccountTokensIfRefreshTokenMatches: mock(async () => {
				throw new Error("db unavailable");
			}),
		});
		recordPendingRotation("acc-1", {
			accessToken: "access-1",
			expiresAt: 999,
			attemptedRefreshToken: "refresh-old",
		});

		const outcome = await flushPendingRotation("acc-1", dbOps);

		expect(outcome).toBe("failed");
		expect(getPendingRotation("acc-1")).toBeDefined();
	});
});

describe("size cap", () => {
	it("evicts the oldest entry once more than 100 entries are recorded", () => {
		for (let i = 0; i < 100; i++) {
			recordPendingRotation(`acc-${i}`, {
				accessToken: `access-${i}`,
				expiresAt: i,
				attemptedRefreshToken: `old-${i}`,
			});
		}
		expect(getPendingRotation("acc-0")).toBeDefined();

		recordPendingRotation("acc-100", {
			accessToken: "access-100",
			expiresAt: 100,
			attemptedRefreshToken: "old-100",
		});

		expect(getPendingRotation("acc-0")).toBeUndefined();
		expect(getPendingRotation("acc-1")).toBeDefined();
		expect(getPendingRotation("acc-100")).toBeDefined();
	});
});
