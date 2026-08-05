import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

/**
 * Regression test for PR #379 review finding: Config#getLocalControlSecret()
 * generated a fresh UUID and blindly overwrote the config file whenever its
 * own in-memory `this.data` didn't have local_control_secret set yet — even
 * if another process (e.g. a CLI invocation racing the server's first-ever
 * boot) had already generated and persisted one to the same file in the
 * meantime. The two processes would then permanently disagree until the
 * server restarted.
 *
 * This reproduces the race: construct a second Config instance BEFORE the
 * first instance's write reaches disk, then have the first instance
 * generate+persist its secret, then call getLocalControlSecret() on the
 * second instance. It must adopt the first instance's persisted value
 * instead of generating and writing a different one of its own.
 */
describe("Config#getLocalControlSecret race condition (#379)", () => {
	let dir: string;
	let configPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-race-"));
		configPath = join(dir, "config.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("adopts a concurrently-persisted secret instead of overwriting it", () => {
		// Simulate the race: both Config instances load their in-memory
		// snapshot from the same (as-yet-unwritten-with-a-secret) file before
		// either one generates a secret.
		const first = new Config(configPath);
		const second = new Config(configPath);

		// First instance "wins the race" and persists its generated secret.
		const firstSecret = first.getLocalControlSecret();
		expect(typeof firstSecret).toBe("string");
		expect(firstSecret.length).toBeGreaterThan(0);

		// Second instance calls getLocalControlSecret() afterward. Its
		// in-memory `this.data` still doesn't have the field (it loaded
		// before the first instance wrote), so without the fix it would
		// generate its own different UUID and clobber the file.
		const secondSecret = second.getLocalControlSecret();

		expect(secondSecret).toBe(firstSecret);
	});

	it("re-reads from disk without re-triggering a write (no change event) when adopting", () => {
		const first = new Config(configPath);
		const second = new Config(configPath);

		const firstSecret = first.getLocalControlSecret();

		let changeEventFired = false;
		second.on("change", () => {
			changeEventFired = true;
		});

		const secondSecret = second.getLocalControlSecret();

		expect(secondSecret).toBe(firstSecret);
		expect(changeEventFired).toBe(false);
	});

	it("still generates and persists a secret normally when no race occurs", () => {
		const config = new Config(configPath);
		const secret = config.getLocalControlSecret();
		expect(typeof secret).toBe("string");
		expect(secret.length).toBeGreaterThan(0);

		// A second call on the same instance returns the same value (fast
		// path, no disk re-read needed).
		expect(config.getLocalControlSecret()).toBe(secret);

		// A brand-new Config instance pointed at the same file also resolves
		// to the same persisted value.
		const reloaded = new Config(configPath);
		expect(reloaded.getLocalControlSecret()).toBe(secret);
	});
});
