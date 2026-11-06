import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	createPoolExhaustedResponse,
	VISION_UNSUPPORTED_MESSAGE,
} from "../proxy-operations";

/**
 * Every eligible route rejecting the request's image input is NOT an exhausted
 * pool: no account is benched, nothing is cooling down, and retrying the same
 * request fails identically forever. Answering `pool_exhausted` (503 +
 * Retry-After) told clients and body-reading consumers to wait for a recovery
 * that never comes, and made "my images stopped working" look like an outage.
 */
describe("createPoolExhaustedResponse — vision_unsupported", () => {
	it("answers 400, not the transient 503", async () => {
		const res = createPoolExhaustedResponse(
			[],
			undefined,
			"vision_unsupported",
		);
		expect(res.status).toBe(400);
	});

	it("carries no Retry-After and no next_available_at", async () => {
		const res = createPoolExhaustedResponse(
			[],
			undefined,
			"vision_unsupported",
		);
		expect(res.headers.get("Retry-After")).toBeNull();

		const body = (await res.json()) as {
			error: { next_available_at: unknown; message: string };
		};
		expect(body.error.next_available_at).toBeNull();
	});

	it("names the cause in error.type, message and the pool-status header", async () => {
		const res = createPoolExhaustedResponse(
			[],
			undefined,
			"vision_unsupported",
		);
		const body = (await res.json()) as {
			error: { type: string; message: string; accounts: unknown[] };
		};
		expect(body.error.type).toBe("vision_unsupported");
		expect(body.error.message).toBe(VISION_UNSUPPORTED_MESSAGE);
		expect(res.headers.get("x-better-ccflare-pool-status")).toBe(
			"vision_unsupported",
		);
	});

	it("leaves the other kinds on the 503 transient shape", async () => {
		for (const kind of ["pool_exhausted", "circuit_open"] as const) {
			const res = createPoolExhaustedResponse([], undefined, kind);
			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).not.toBeNull();
			expect(res.headers.get("x-better-ccflare-pool-status")).toBe("exhausted");
			const body = (await res.json()) as { error: { type: string } };
			expect(body.error.type).toBe(kind);
		}
	});

	/**
	 * The routing caller passes `[]`, so the two cases below are about the builder
	 * as a public surface: any other caller that does hand it accounts must get the
	 * same "nothing here is recovering" story in the per-account entries and in the
	 * aggregate wait signal. Both use an account with a live cooldown, which is the
	 * state that would otherwise supply a reason and a recovery time.
	 */
	function coolingAccount(): Account {
		return {
			id: "acc-1",
			name: "cooling-account",
			provider: "test-provider",
			rate_limited_until: Date.now() + 600_000,
			paused: false,
			priority: 0,
		} as Account;
	}

	it("reports the per-account reason as vision_unsupported, not a cooldown", async () => {
		const res = createPoolExhaustedResponse(
			[coolingAccount()],
			undefined,
			"vision_unsupported",
		);
		const body = (await res.json()) as {
			error: {
				accounts: Array<{
					name: string;
					reason: string;
					available_at: string | null;
				}>;
			};
		};

		// Reporting `rate_limited` here would send a body-reading consumer off to
		// wait out a cooldown that has nothing to do with why the request failed.
		expect(body.error.accounts).toHaveLength(1);
		expect(body.error.accounts[0].reason).toBe("vision_unsupported");
		// And no recovery time in the entry either: it would contradict the reason
		// sitting next to it in the same object.
		expect(body.error.accounts[0].available_at).toBeNull();
	});

	it("drops next_available_at even when a cooldown would have supplied one", async () => {
		const res = createPoolExhaustedResponse(
			[coolingAccount()],
			undefined,
			"vision_unsupported",
		);
		const body = (await res.json()) as {
			error: { next_available_at: string | null };
		};

		expect(body.error.next_available_at).toBeNull();
		expect(res.headers.get("Retry-After")).toBeNull();

		// Control: the same account under the transient kind does advertise the
		// cooldown, so the nulls above are the kind's doing and not the fixture's.
		const transient = createPoolExhaustedResponse([coolingAccount()]);
		const transientBody = (await transient.json()) as {
			error: { next_available_at: string | null };
		};
		expect(transientBody.error.next_available_at).not.toBeNull();
		expect(transient.headers.get("Retry-After")).not.toBeNull();
	});
});
