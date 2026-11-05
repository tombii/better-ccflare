import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearVisionCapability,
	DEFAULT_VISION_CAPABILITY_TTL_MS,
	isVisionUnsupported,
	MAX_VISION_CAPABILITY_ENTRIES,
	markVisionUnsupported,
	VISION_CAPABILITY_TTL_MS,
	visionCapabilitySnapshot,
	visionCapabilityTtlMs,
} from "../vision-capability";

/**
 * The TTL is read from the environment on every call (so a change takes effect
 * without a restart), which means these tests can drive expiry by setting the
 * override instead of waiting for a 12-hour window.
 */
const ENV_KEY = "CCFLARE_VISION_CAPABILITY_TTL_MS";
const ENV_AT_IMPORT = process.env[ENV_KEY];

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Marks `count` distinct models on one account, one millisecond apart. */
function fillStore(
	account: string,
	count: number,
	prefix = "m",
	from = NOW,
): void {
	for (let index = 0; index < count; index += 1) {
		markVisionUnsupported(account, `${prefix}${index}`, from + index);
	}
}

beforeEach(() => {
	clearVisionCapability();
	delete process.env[ENV_KEY];
});

afterEach(() => {
	clearVisionCapability();
	if (ENV_AT_IMPORT === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = ENV_AT_IMPORT;
});

describe("markVisionUnsupported / isVisionUnsupported", () => {
	it("reports a marked pair as unsupported and an unmarked pair as not", () => {
		markVisionUnsupported("accountA", "glm-4.5-air", NOW);

		expect(isVisionUnsupported("accountA", "glm-4.5-air", NOW)).toBe(true);
		expect(isVisionUnsupported("accountA", "glm-4.6", NOW)).toBe(false);
		expect(isVisionUnsupported("accountB", "never-marked", NOW)).toBe(false);
	});

	it("expires an entry exactly at the TTL, not one millisecond before", () => {
		markVisionUnsupported("accountA", "m", NOW);

		expect(
			isVisionUnsupported(
				"accountA",
				"m",
				NOW + DEFAULT_VISION_CAPABILITY_TTL_MS - 1,
			),
		).toBe(true);
		// `age >= ttl` is expired, the same inclusive boundary the 429 cooldown
		// store uses for `until <= now`.
		expect(
			isVisionUnsupported(
				"accountA",
				"m",
				NOW + DEFAULT_VISION_CAPABILITY_TTL_MS,
			),
		).toBe(false);
		expect(
			isVisionUnsupported(
				"accountA",
				"m",
				NOW + DEFAULT_VISION_CAPABILITY_TTL_MS + 1,
			),
		).toBe(false);
	});

	it("keeps a marked pair unsupported for the whole default window", () => {
		markVisionUnsupported("accountA", "m", NOW);

		expect(isVisionUnsupported("accountA", "m", NOW + 11 * HOUR)).toBe(true);
		expect(isVisionUnsupported("accountA", "m", NOW + 13 * HOUR)).toBe(false);
	});

	it("applies the env override to entries already in the store", () => {
		markVisionUnsupported("accountA", "m", NOW);

		process.env[ENV_KEY] = String(10 * MINUTE);

		expect(isVisionUnsupported("accountA", "m", NOW + 10 * MINUTE - 1)).toBe(
			true,
		);
		expect(isVisionUnsupported("accountA", "m", NOW + 10 * MINUTE)).toBe(false);
	});

	it("keys entries per account, so one gateway's refusal does not sideline another's", () => {
		markVisionUnsupported("accountA", "deepseek-v4.1-flash", NOW);

		expect(isVisionUnsupported("accountA", "deepseek-v4.1-flash", NOW)).toBe(
			true,
		);
		expect(isVisionUnsupported("accountB", "deepseek-v4.1-flash", NOW)).toBe(
			false,
		);
	});

	it("keys entries per model, so one model's refusal does not sideline its siblings", () => {
		markVisionUnsupported("accountA", "model-one", NOW);

		expect(isVisionUnsupported("accountA", "model-one", NOW)).toBe(true);
		expect(isVisionUnsupported("accountA", "model-two", NOW)).toBe(false);
	});

	it("does not merge an account id that is a prefix of another", () => {
		markVisionUnsupported("account", "m", NOW);

		expect(isVisionUnsupported("accountA", "m", NOW)).toBe(false);
		expect(isVisionUnsupported("account", "m", NOW)).toBe(true);
	});

	it("keeps a routing suffix distinct from the bare model id", () => {
		markVisionUnsupported(
			"accountA",
			'deepseek-v4.1-flash {"only":["deepseek"]}',
			NOW,
		);

		expect(
			isVisionUnsupported(
				"accountA",
				'deepseek-v4.1-flash {"only":["deepseek"]}',
				NOW,
			),
		).toBe(true);
		// The suffix picks the upstream that answers, and vision support belongs
		// to that upstream — so the bare id is still untried.
		expect(isVisionUnsupported("accountA", "deepseek-v4.1-flash", NOW)).toBe(
			false,
		);
	});

	it("trims the model on write and on read", () => {
		markVisionUnsupported("accountA", "  glm-4.5-air  ", NOW);

		expect(isVisionUnsupported("accountA", "glm-4.5-air", NOW)).toBe(true);
		expect(isVisionUnsupported("accountA", "\tglm-4.5-air\n", NOW)).toBe(true);
		expect(visionCapabilitySnapshot(NOW)[0]?.model).toBe("glm-4.5-air");
	});

	it("trims the account id on write and on read", () => {
		markVisionUnsupported("  accountA  ", "m", NOW);

		expect(isVisionUnsupported("accountA", "m", NOW)).toBe(true);
		expect(visionCapabilitySnapshot(NOW)[0]?.accountId).toBe("accountA");
	});

	it("is a no-op for an empty or whitespace-only model", () => {
		markVisionUnsupported("accountA", "", NOW);
		markVisionUnsupported("accountA", "   ", NOW);
		markVisionUnsupported("accountA", "\t\n", NOW);

		expect(visionCapabilitySnapshot(NOW)).toEqual([]);
		expect(isVisionUnsupported("accountA", "", NOW)).toBe(false);
		expect(isVisionUnsupported("accountA", "   ", NOW)).toBe(false);
		// A blank model must not create an entry that suppresses real models.
		expect(isVisionUnsupported("accountA", "glm-4.5-air", NOW)).toBe(false);
	});

	it("is a no-op for an empty or whitespace-only account id", () => {
		markVisionUnsupported("", "m", NOW);
		markVisionUnsupported("   ", "m", NOW);

		expect(visionCapabilitySnapshot(NOW)).toEqual([]);
		expect(isVisionUnsupported("", "m", NOW)).toBe(false);
		expect(isVisionUnsupported("   ", "m", NOW)).toBe(false);
	});

	it("re-marking the same pair refreshes learnedAt instead of duplicating it", () => {
		markVisionUnsupported("accountA", "m", NOW);
		markVisionUnsupported("accountA", "m", NOW + HOUR);

		const snapshot = visionCapabilitySnapshot(NOW + HOUR);
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]?.learnedAt).toBe(NOW + HOUR);
		expect(
			isVisionUnsupported(
				"accountA",
				"m",
				NOW + HOUR + DEFAULT_VISION_CAPABILITY_TTL_MS - 1,
			),
		).toBe(true);
	});

	it("deletes an expired entry on read rather than leaving it to the cap", () => {
		process.env[ENV_KEY] = String(MINUTE);
		markVisionUnsupported("accountA", "m", NOW);

		expect(isVisionUnsupported("accountA", "m", NOW + MINUTE)).toBe(false);

		// The entry is gone, not merely expired: a much longer TTL applied to the
		// same `now` would resurrect it if the read had left it in the map.
		process.env[ENV_KEY] = String(24 * HOUR);
		expect(isVisionUnsupported("accountA", "m", NOW + MINUTE)).toBe(false);
		expect(visionCapabilitySnapshot(NOW + MINUTE)).toEqual([]);
	});
});

describe("clearVisionCapability", () => {
	it("clears every account when called with no argument", () => {
		markVisionUnsupported("accountA", "m1", NOW);
		markVisionUnsupported("accountB", "m2", NOW);

		clearVisionCapability();

		expect(isVisionUnsupported("accountA", "m1", NOW)).toBe(false);
		expect(isVisionUnsupported("accountB", "m2", NOW)).toBe(false);
		expect(visionCapabilitySnapshot(NOW)).toEqual([]);
	});

	it("clears only the named account", () => {
		markVisionUnsupported("accountA", "m1", NOW);
		markVisionUnsupported("accountA", "m2", NOW);
		markVisionUnsupported("accountB", "m1", NOW);

		clearVisionCapability("accountA");

		expect(isVisionUnsupported("accountA", "m1", NOW)).toBe(false);
		expect(isVisionUnsupported("accountA", "m2", NOW)).toBe(false);
		expect(isVisionUnsupported("accountB", "m1", NOW)).toBe(true);
		expect(visionCapabilitySnapshot(NOW)).toEqual([
			{ accountId: "accountB", model: "m1", learnedAt: NOW },
		]);
	});

	it("does not treat an account id that prefixes another as that account", () => {
		markVisionUnsupported("accountA", "m", NOW);
		markVisionUnsupported("accountAB", "m", NOW);

		clearVisionCapability("accountA");

		expect(isVisionUnsupported("accountA", "m", NOW)).toBe(false);
		expect(isVisionUnsupported("accountAB", "m", NOW)).toBe(true);
	});

	it("trims the account id it clears", () => {
		markVisionUnsupported("accountA", "m", NOW);

		clearVisionCapability("  accountA  ");

		expect(isVisionUnsupported("accountA", "m", NOW)).toBe(false);
	});

	it("does not clear everything for an empty or whitespace-only account id", () => {
		markVisionUnsupported("accountA", "m", NOW);

		clearVisionCapability("");
		clearVisionCapability("   ");

		expect(isVisionUnsupported("accountA", "m", NOW)).toBe(true);
	});

	it("is safe to call for an account that was never marked", () => {
		markVisionUnsupported("accountA", "m", NOW);

		clearVisionCapability("accountB");

		expect(isVisionUnsupported("accountA", "m", NOW)).toBe(true);
	});
});

describe("entry cap", () => {
	it("evicts the oldest-learned entry once the cap is reached", () => {
		fillStore("accountA", MAX_VISION_CAPABILITY_ENTRIES);
		const at = NOW + MAX_VISION_CAPABILITY_ENTRIES;

		expect(visionCapabilitySnapshot(at)).toHaveLength(
			MAX_VISION_CAPABILITY_ENTRIES,
		);

		markVisionUnsupported("accountA", "newest", at);

		const snapshot = visionCapabilitySnapshot(at);
		expect(snapshot).toHaveLength(MAX_VISION_CAPABILITY_ENTRIES);
		expect(isVisionUnsupported("accountA", "m0", at)).toBe(false);
		expect(isVisionUnsupported("accountA", "m1", at)).toBe(true);
		expect(isVisionUnsupported("accountA", "newest", at)).toBe(true);
	});

	it("never grows past the cap under sustained marking", () => {
		fillStore("accountA", MAX_VISION_CAPABILITY_ENTRIES * 2);

		expect(
			visionCapabilitySnapshot(NOW + MAX_VISION_CAPABILITY_ENTRIES * 2),
		).toHaveLength(MAX_VISION_CAPABILITY_ENTRIES);
	});

	it("re-marking a pair makes it the newest, so the next eviction skips it", () => {
		fillStore("accountA", MAX_VISION_CAPABILITY_ENTRIES);
		const at = NOW + MAX_VISION_CAPABILITY_ENTRIES;

		// m0 is the oldest, but re-learning it now makes it the newest.
		markVisionUnsupported("accountA", "m0", at);
		markVisionUnsupported("accountA", "newest", at + 1);

		expect(isVisionUnsupported("accountA", "m0", at + 1)).toBe(true);
		expect(isVisionUnsupported("accountA", "m1", at + 1)).toBe(false);
		expect(isVisionUnsupported("accountA", "newest", at + 1)).toBe(true);
		expect(visionCapabilitySnapshot(at + 1)).toHaveLength(
			MAX_VISION_CAPABILITY_ENTRIES,
		);
	});

	it("prunes expired entries on write instead of evicting live ones", () => {
		process.env[ENV_KEY] = String(MINUTE);
		fillStore("accountA", MAX_VISION_CAPABILITY_ENTRIES);
		// Past the TTL even for the newest of the filled entries, which are
		// stamped one millisecond apart.
		const at = NOW + MINUTE + MAX_VISION_CAPABILITY_ENTRIES;

		markVisionUnsupported("accountA", "fresh", at);

		expect(visionCapabilitySnapshot(at)).toEqual([
			{ accountId: "accountA", model: "fresh", learnedAt: at },
		]);
	});

	it("counts entries across accounts against the same cap", () => {
		fillStore("accountA", MAX_VISION_CAPABILITY_ENTRIES / 2);
		fillStore(
			"accountB",
			MAX_VISION_CAPABILITY_ENTRIES / 2,
			"m",
			NOW + MAX_VISION_CAPABILITY_ENTRIES / 2,
		);
		const at = NOW + MAX_VISION_CAPABILITY_ENTRIES;

		markVisionUnsupported("accountC", "m", at);

		const snapshot = visionCapabilitySnapshot(at);
		expect(snapshot).toHaveLength(MAX_VISION_CAPABILITY_ENTRIES);
		// accountA's oldest entry went first: the cap is global, not per account.
		expect(isVisionUnsupported("accountA", "m0", at)).toBe(false);
		expect(isVisionUnsupported("accountA", "m1", at)).toBe(true);
		expect(isVisionUnsupported("accountB", "m0", at)).toBe(true);
		expect(isVisionUnsupported("accountC", "m", at)).toBe(true);
	});
});

describe("visionCapabilitySnapshot", () => {
	it("is empty when nothing was marked", () => {
		expect(visionCapabilitySnapshot(NOW)).toEqual([]);
	});

	it("lists unexpired entries oldest-learned first", () => {
		markVisionUnsupported("accountB", "m2", NOW + 2 * MINUTE);
		markVisionUnsupported("accountA", "m1", NOW + MINUTE);
		markVisionUnsupported("accountA", "m0", NOW);

		expect(visionCapabilitySnapshot(NOW + 2 * MINUTE)).toEqual([
			{ accountId: "accountA", model: "m0", learnedAt: NOW },
			{ accountId: "accountA", model: "m1", learnedAt: NOW + MINUTE },
			{ accountId: "accountB", model: "m2", learnedAt: NOW + 2 * MINUTE },
		]);
	});

	it("omits and drops expired entries", () => {
		process.env[ENV_KEY] = String(10 * MINUTE);
		markVisionUnsupported("accountA", "stale", NOW);
		markVisionUnsupported("accountA", "current", NOW + 9 * MINUTE);

		const snapshot = visionCapabilitySnapshot(NOW + 10 * MINUTE);
		expect(snapshot).toEqual([
			{ accountId: "accountA", model: "current", learnedAt: NOW + 9 * MINUTE },
		]);

		// The stale entry was dropped while the snapshot was built, so widening
		// the TTL afterwards does not bring it back.
		process.env[ENV_KEY] = String(24 * HOUR);
		expect(visionCapabilitySnapshot(NOW + 10 * MINUTE)).toEqual(snapshot);
	});

	it("returns copies, so mutating the result cannot change the store", () => {
		markVisionUnsupported("accountA", "m", NOW);

		const snapshot = visionCapabilitySnapshot(NOW);
		expect(snapshot[0]).toBeDefined();
		snapshot[0].model = "tampered";
		snapshot[0].learnedAt = 0;
		snapshot.push({ accountId: "injected", model: "x", learnedAt: NOW });

		expect(isVisionUnsupported("accountA", "m", NOW)).toBe(true);
		expect(isVisionUnsupported("accountA", "tampered", NOW)).toBe(false);
		expect(visionCapabilitySnapshot(NOW)).toEqual([
			{ accountId: "accountA", model: "m", learnedAt: NOW },
		]);
	});
});

describe("TTL resolution", () => {
	it("defaults to 12 hours", () => {
		expect(DEFAULT_VISION_CAPABILITY_TTL_MS).toBe(12 * HOUR);
		expect(visionCapabilityTtlMs()).toBe(DEFAULT_VISION_CAPABILITY_TTL_MS);
	});

	it("honours a positive env override", () => {
		process.env[ENV_KEY] = String(30 * MINUTE);

		expect(visionCapabilityTtlMs()).toBe(30 * MINUTE);
	});

	it.each([
		"",
		"   ",
		"0",
		"-1",
		"abc",
		"NaN",
		"null",
		"undefined",
		"Infinity",
		"1e999",
	])("falls back to the default for the garbage override %p", (raw) => {
		process.env[ENV_KEY] = raw;

		expect(visionCapabilityTtlMs()).toBe(DEFAULT_VISION_CAPABILITY_TTL_MS);
	});

	it("accepts a padded or fractional override the way other duration env vars do", () => {
		process.env[ENV_KEY] = " 60000 ";
		expect(visionCapabilityTtlMs()).toBe(60000);

		process.env[ENV_KEY] = "1500.5";
		expect(visionCapabilityTtlMs()).toBe(1500.5);
	});

	it("exports the TTL resolved at import", () => {
		expect(Number.isFinite(VISION_CAPABILITY_TTL_MS)).toBe(true);
		expect(VISION_CAPABILITY_TTL_MS).toBeGreaterThan(0);
		// The suite does not set the override before import, so the load-time
		// resolution falls back to the compiled-in default.
		if (ENV_AT_IMPORT === undefined) {
			expect(VISION_CAPABILITY_TTL_MS).toBe(DEFAULT_VISION_CAPABILITY_TTL_MS);
		}
	});
});
