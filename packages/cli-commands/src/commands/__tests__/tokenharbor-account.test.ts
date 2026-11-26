import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import type { PromptAdapter } from "../../prompts";
import { addAccount } from "../account";

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

describe("CLI TokenHarbor account", () => {
	let dbOps: DatabaseOperations;
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(
			tmpdir(),
			`test-tokenharbor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

	it("persists --modelMappings on a tokenharbor account", async () => {
		await addAccount(dbOps, config, {
			name: "th-mapped",
			mode: "tokenharbor",
			modelMappings: { opus: "deepseek-v4-pro" },
			adapter: adapterReturning("sk-test-0123456789"),
		});

		const row = await dbOps.getAdapter().get<{
			provider: string;
			custom_endpoint: string | null;
			model_mappings: string | null;
			model_fallbacks: string | null;
		}>(
			"SELECT provider, custom_endpoint, model_mappings, model_fallbacks FROM accounts WHERE name = ?",
			["th-mapped"],
		);

		expect(row?.provider).toBe("tokenharbor");
		expect(row?.custom_endpoint).toBe("https://tokenharbor.ai");
		expect(JSON.parse(row?.model_mappings ?? "null")).toEqual({
			opus: "deepseek-v4-pro",
		});
		expect(row?.model_fallbacks).toBeNull();
	});
});
