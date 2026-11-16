import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, REASONING_EFFORTS_ENV_VAR } from "./index";

describe("reasoning effort overrides (CCFLARE_REASONING_EFFORTS / reasoning_efforts)", () => {
	const ORIGINAL_ENV = process.env.CCFLARE_REASONING_EFFORTS;
	let directory: string;
	let path: string;

	beforeEach(() => {
		delete process.env.CCFLARE_REASONING_EFFORTS;
		directory = mkdtempSync(join(tmpdir(), "ccflare-reasoning-efforts-"));
		path = join(directory, "config.json");
	});

	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.CCFLARE_REASONING_EFFORTS;
		} else {
			process.env.CCFLARE_REASONING_EFFORTS = ORIGINAL_ENV;
		}
		rmSync(directory, { recursive: true, force: true });
	});

	function makeConfig(data: Record<string, unknown> = {}) {
		writeFileSync(path, JSON.stringify(data));
		return new Config(path);
	}

	it("names the env var", () => {
		expect(REASONING_EFFORTS_ENV_VAR).toBe("CCFLARE_REASONING_EFFORTS");
	});

	it("defaults to an empty map", () => {
		expect(makeConfig().getReasoningEffortOverrides()).toEqual({});
	});

	it("reads the config-file field", () => {
		const config = makeConfig({
			reasoning_efforts: { "grok-4.7-build-fast": ["low", "high"] },
		});
		expect(config.getReasoningEffortOverrides()).toEqual({
			"grok-4.7-build-fast": ["low", "high"],
		});
	});

	it("prefers the env var over the config file", () => {
		process.env.CCFLARE_REASONING_EFFORTS = JSON.stringify({
			"deepseek-v4.1-flash": ["low", "high", "max"],
		});
		const config = makeConfig({
			reasoning_efforts: { "grok-4.7-build-fast": ["low", "high"] },
		});
		expect(config.getReasoningEffortOverrides()).toEqual({
			"deepseek-v4.1-flash": ["low", "high", "max"],
		});
	});

	it("falls back to the file when the env var is not valid JSON or not an object", () => {
		const config = makeConfig({ reasoning_efforts: { m: ["low"] } });
		process.env.CCFLARE_REASONING_EFFORTS = "{not json";
		expect(config.getReasoningEffortOverrides()).toEqual({ m: ["low"] });
		process.env.CCFLARE_REASONING_EFFORTS = JSON.stringify(["low"]);
		expect(config.getReasoningEffortOverrides()).toEqual({ m: ["low"] });
		process.env.CCFLARE_REASONING_EFFORTS = "   ";
		expect(config.getReasoningEffortOverrides()).toEqual({ m: ["low"] });
	});

	it("drops entries whose value is not an array of strings", () => {
		const config = makeConfig({
			reasoning_efforts: {
				good: ["low", "high"],
				notArray: "low",
				mixed: ["low", 3],
				empty: [],
			},
		});
		expect(config.getReasoningEffortOverrides()).toEqual({
			good: ["low", "high"],
			mixed: ["low"],
		});
	});

	it("persists the file field and emits a change event", () => {
		const config = makeConfig();
		const events: string[] = [];
		config.on("change", ({ key }: { key: string }) => events.push(key));
		config.setReasoningEffortOverrides({ m: ["low", "medium"] });
		expect(config.getReasoningEffortOverrides()).toEqual({
			m: ["low", "medium"],
		});
		expect(JSON.parse(readFileSync(path, "utf8")).reasoning_efforts).toEqual({
			m: ["low", "medium"],
		});
		expect(events).toContain("reasoning_efforts");
	});
});
