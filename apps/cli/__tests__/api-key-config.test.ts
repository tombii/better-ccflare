import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliPath = resolve("apps/cli/src/main.ts");

describe("API key CLI configuration", () => {
	let directory: string;
	let dbPath: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "bcf-key-options-"));
		dbPath = join(directory, "test.db");
	});
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	async function run(...args: string[]) {
		const child = Bun.spawn([process.execPath, "run", cliPath, ...args], {
			env: {
				...process.env,
				DATABASE_URL: "",
				NODE_ENV: "test",
				BETTER_CCFLARE_DB_PATH: dbPath,
				BETTER_CCFLARE_LOG_DIR: directory,
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		return { code: await child.exited, stderr };
	}

	it("creates calendar/model budgets and preserves restrictions while changing mode/routing", async () => {
		const create = await run(
			"--generate-api-key",
			"app",
			"--allow-models",
			"opus,sonnet",
			"--allow-accounts",
			"account-id",
			"--allow-providers",
			"codex",
			"--limit",
			"window=day,usd=5",
			"--limit",
			"window=hour,usd=1,model=opus,warn",
		);
		expect(create.code).toBe(0);
		const db = new Database(dbPath);
		try {
			const key = db
				.query<
					{
						id: string;
						limit_window_mode: string;
						allowed_models: string;
						allowed_accounts: string;
						allowed_providers: string;
					},
					[]
				>(
					"SELECT id,limit_window_mode,allowed_models,allowed_accounts,allowed_providers FROM api_keys",
				)
				.get();
			expect(key?.limit_window_mode).toBe("calendar");
			expect(JSON.parse(key?.allowed_models ?? "null")).toEqual([
				"opus",
				"sonnet",
			]);
			expect(JSON.parse(key?.allowed_accounts ?? "null")).toEqual([
				"account-id",
			]);
			expect(JSON.parse(key?.allowed_providers ?? "null")).toEqual(["codex"]);
			expect(
				db
					.query(
						"SELECT scope_model,window,limit_usd,enforce FROM api_key_limits ORDER BY window",
					)
					.all(),
			).toEqual([
				{ scope_model: null, window: "day", limit_usd: 5, enforce: "block" },
				{ scope_model: "opus", window: "hour", limit_usd: 1, enforce: "warn" },
			]);
			db.run(
				"INSERT INTO combos (id,name,enabled,created_at,updated_at) VALUES ('codex-combo','Codex',1,1,1)",
			);
			const update = await run(
				"--update-api-key",
				"app",
				"--limit-mode",
				"rolling",
				"--routing",
				"opus=codex-combo",
				"--allow-models",
				"none",
			);
			expect(update.code).toBe(0);
			const updated = db
				.query(
					"SELECT limit_window_mode,family_combo_overrides,allowed_models,allowed_accounts FROM api_keys",
				)
				.get();
			expect(updated).toEqual({
				limit_window_mode: "rolling",
				family_combo_overrides: '{"opus":"codex-combo"}',
				allowed_models: "[]",
				allowed_accounts: '["account-id"]',
			});
			expect(
				db
					.query<{ count: number }, []>(
						"SELECT COUNT(*) AS count FROM api_key_limits",
					)
					.get()?.count,
			).toBe(2);
			const clear = await run(
				"--update-api-key",
				"app",
				"--clear-limits",
				"--clear-routing",
				"--allow-models",
				"*",
			);
			expect(clear.code).toBe(0);
			expect(
				db
					.query("SELECT family_combo_overrides,allowed_models FROM api_keys")
					.get(),
			).toEqual({ family_combo_overrides: null, allowed_models: null });
			expect(
				db
					.query<{ count: number }, []>(
						"SELECT COUNT(*) AS count FROM api_key_limits",
					)
					.get()?.count,
			).toBe(0);
		} finally {
			db.close();
		}
	});

	it("rejects invalid options without creating a key or starting the server", async () => {
		const invalid = await run(
			"--generate-api-key",
			"bad",
			"--limit",
			"window=day,usd=0",
		);
		expect(invalid.code).toBe(1);
		expect(invalid.stderr).toContain("greater than 0");
		const orphan = await run("--limit", "window=day,usd=5");
		expect(orphan.code).toBe(1);
		expect(orphan.stderr).toContain(
			"require --generate-api-key or --update-api-key",
		);
	});
});
