import { describe, expect, it } from "bun:test";
import { parseArgs } from "node:util";
import { CLI_OPTIONS } from "../runner";

/**
 * `parseArgs` matches option keys exactly against the flag as typed. A
 * camelCase key (`nightWindow`) therefore never populates from the advertised
 * `--night-window`, and the flag is silently ignored. These tests pin the
 * option map to the flags the CLI documents.
 */
describe("CLI option names", () => {
	function parse(args: string[]) {
		return parseArgs({ args, strict: false, options: CLI_OPTIONS }).values;
	}

	it("populates night-window from --night-window", () => {
		expect(parse(["--night-window", "on"])["night-window"]).toBe("on");
	});

	it("populates night-window from --night-window=off", () => {
		expect(parse(["--night-window=off"])["night-window"]).toBe("off");
	});

	it("does not expose a camelCase nightWindow key", () => {
		const values = parse(["--night-window", "on"]) as Record<string, unknown>;
		expect(values.nightWindow).toBeUndefined();
	});

	it("still parses the pre-existing flags", () => {
		const values = parse([
			"--mode",
			"sailresearch",
			"--priority",
			"3",
			"--modelMappings",
			"{}",
		]);
		expect(values.mode).toBe("sailresearch");
		expect(values.priority).toBe("3");
		expect(values.modelMappings).toBe("{}");
	});

	it("matches the flag spelling the usage text advertises", () => {
		// `modelMappings` is deliberately camelCase: that is the spelling
		// documented in the CLI help. `night-window` is advertised in kebab-case.
		expect(Object.keys(CLI_OPTIONS)).toContain("night-window");
		expect(Object.keys(CLI_OPTIONS)).not.toContain("nightWindow");
	});
});
