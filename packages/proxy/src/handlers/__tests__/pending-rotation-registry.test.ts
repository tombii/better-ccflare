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

	it("replaces accessToken/expiresAt but preserves the original attemptedRefreshToken anchor", () => {
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
		// (round-3 final review, C1) The anchor stays "old-1" — the token the
		// DB actually still holds — not "old-2", which the second rotation
		// only ever consumed in-memory.
		expect(entry?.attemptedRefreshToken).toBe("old-1");
	});
});

describe("recordPendingRotation — anchor compression across chained rotations (round-3 final review, C1)", () => {
	it("keeps the original anchor through a 3-link chain and flushes against it", async () => {
		recordPendingRotation("acc-1", {
			accessToken: "access-2",
			expiresAt: 2,
			refreshToken: "RT2",
			attemptedRefreshToken: "RT1",
		});
		recordPendingRotation("acc-1", {
			accessToken: "access-3",
			expiresAt: 3,
			refreshToken: "RT3",
			attemptedRefreshToken: "RT2",
		});

		const entry = getPendingRotation("acc-1");
		expect(entry?.attemptedRefreshToken).toBe("RT1");
		expect(entry?.refreshToken).toBe("RT3");
		expect(entry?.accessToken).toBe("access-3");
		expect(entry?.expiresAt).toBe(3);

		const dbOps = makeDbOps({
			updateAccountTokensIfRefreshTokenMatches: mock(async () => true),
		});
		const outcome = await flushPendingRotation("acc-1", dbOps);

		expect(outcome).toBe("persisted");
		expect(dbOps.updateAccountTokensIfRefreshTokenMatches).toHaveBeenCalledWith(
			"acc-1",
			"RT1",
			"access-3",
			3,
			"RT3",
		);
	});
});

describe("flushPendingRotation — identity-guarded delete (round-3 final review, I2)", () => {
	it("does not delete a newer entry re-recorded while the CAS write is still in flight", async () => {
		let resolveCas: (value: boolean) => void = () => {};
		const casPromise = new Promise<boolean>((resolve) => {
			resolveCas = resolve;
		});
		const dbOps = makeDbOps({
			updateAccountTokensIfRefreshTokenMatches: mock(() => casPromise),
		});
		recordPendingRotation("acc-1", {
			accessToken: "access-1",
			expiresAt: 1,
			refreshToken: "RT2",
			attemptedRefreshToken: "RT1",
		});

		const flushPromise = flushPendingRotation("acc-1", dbOps);

		// A newer rotation lands in the registry while the CAS write above is
		// still awaiting resolution (e.g. a concurrent request-triggered
		// refresh's own failed persist).
		recordPendingRotation("acc-1", {
			accessToken: "access-2",
			expiresAt: 2,
			refreshToken: "RT3",
			attemptedRefreshToken: "RT2",
		});

		resolveCas(true);
		const outcome = await flushPromise;

		expect(outcome).toBe("persisted");
		const entry = getPendingRotation("acc-1");
		expect(entry).toBeDefined();
		expect(entry?.accessToken).toBe("access-2");
		expect(entry?.refreshToken).toBe("RT3");
		// Anchor compression applies here too: the newer entry was recorded
		// while the original (RT1-anchored) entry was still present.
		expect(entry?.attemptedRefreshToken).toBe("RT1");
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
