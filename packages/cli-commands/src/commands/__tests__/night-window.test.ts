import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import type { PromptAdapter } from "../../prompts";
import {
	addAccount,
	parseNightWindowValue,
	setAccountNightWindow,
} from "../account";

const config = {} as Config;

function adapterReturning(apiKey: string): PromptAdapter {
	return {
		async select(_question, options) {
			return options[0].value;
		},
		async input() {
			return apiKey;
		},
		async confirm() {
			return true;
		},
	};
}

describe("parseNightWindowValue", () => {
	it.each([
		["on", true],
		["off", false],
		["true", true],
		["false", false],
		["1", true],
		["0", false],
		["ON", true],
		[" Off ", false],
	])("parses %p as %p", (raw, expected) => {
		expect(parseNightWindowValue(raw)).toEqual({ ok: true, value: expected });
	});

	it.each(["yes", "enabled", "2", "", "onoff"])("rejects %p", (raw) => {
		expect(parseNightWindowValue(raw)).toEqual({ ok: false });
	});
});

describe("CLI night-window flag", () => {
	let dbOps: DatabaseOperations;
	let dbPath: string;

	async function nightWindowOf(name: string): Promise<unknown> {
		const row = await dbOps
			.getAdapter()
			.get<{ night_window_enabled: unknown }>(
				"SELECT night_window_enabled FROM accounts WHERE name = ?",
				[name],
			);
		return row?.night_window_enabled;
	}

	beforeEach(() => {
		dbPath = join(
			tmpdir(),
			`test-night-window-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
		);
		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		// Close BEFORE unlinking so the WAL checkpoint does not fail.
		DatabaseFactory.reset();
		for (const suffix of ["", "-wal", "-shm"]) {
			const p = `${dbPath}${suffix}`;
			if (existsSync(p)) unlinkSync(p);
		}
	});

	it("sets the column at creation when --night-window on", async () => {
		await addAccount(dbOps, config, {
			name: "sail-on",
			mode: "sailresearch",
			nightWindow: true,
			adapter: adapterReturning("sk-test-0123456789"),
		});

		expect(Number(await nightWindowOf("sail-on"))).toBe(1);
		const row = await dbOps
			.getAdapter()
			.get<{ provider: string }>(
				"SELECT provider FROM accounts WHERE name = ?",
				["sail-on"],
			);
		expect(row?.provider).toBe("sailresearch");
	});

	it("leaves the column off at creation when --night-window is omitted", async () => {
		await addAccount(dbOps, config, {
			name: "sail-default",
			mode: "sailresearch",
			adapter: adapterReturning("sk-test-0123456789"),
		});

		expect(Number((await nightWindowOf("sail-default")) ?? 0)).toBe(0);
	});

	it("setter toggles the column on and off", async () => {
		await addAccount(dbOps, config, {
			name: "sail-toggle",
			mode: "sailresearch",
			adapter: adapterReturning("sk-test-0123456789"),
		});

		const on = await setAccountNightWindow(dbOps, "sail-toggle", "on");
		expect(on.success).toBe(true);
		expect(on.message).toContain("night window set to on");
		expect(Number(await nightWindowOf("sail-toggle"))).toBe(1);

		const off = await setAccountNightWindow(dbOps, "sail-toggle", "false");
		expect(off.success).toBe(true);
		expect(off.message).toContain("night window set to off");
		expect(Number(await nightWindowOf("sail-toggle"))).toBe(0);
	});

	it("setter rejects an invalid value with a clear error", async () => {
		await addAccount(dbOps, config, {
			name: "sail-invalid",
			mode: "sailresearch",
			nightWindow: true,
			adapter: adapterReturning("sk-test-0123456789"),
		});

		const result = await setAccountNightWindow(dbOps, "sail-invalid", "maybe");
		expect(result.success).toBe(false);
		expect(result.message).toContain("Invalid night-window value 'maybe'");
		expect(result.message).toContain("on/off");
		// Unchanged
		expect(Number(await nightWindowOf("sail-invalid"))).toBe(1);
	});

	it("setter errors on an unknown account", async () => {
		const result = await setAccountNightWindow(dbOps, "nope", "on");
		expect(result.success).toBe(false);
		expect(result.message).toBe("Account 'nope' not found");
	});
});
