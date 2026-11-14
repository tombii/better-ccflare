import { describe, expect, it, spyOn } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	getProviderModelDefaultOverrides,
	setProviderModelDefaultOverrides,
} from "@better-ccflare/providers";
import {
	configureApiKey,
	generateConfiguredApiKey,
	parseApiKeyAllowList,
	parseApiKeyLimit,
	parseApiKeyLimitMode,
	parseApiKeyRouting,
	validateApiKeyOptions,
} from "../api-key-options";

describe("API key CLI options", () => {
	it("preserves unrestricted and deny-all allow lists", () => {
		expect(parseApiKeyAllowList("*")).toBeNull();
		expect(parseApiKeyAllowList("none")).toEqual([]);
		expect(parseApiKeyAllowList("opus, sonnet,opus")).toEqual([
			"opus",
			"sonnet",
		]);
		expect(() => parseApiKeyAllowList("opus,,sonnet")).toThrow();
	});

	it("parses every window and optional model/warn settings", () => {
		for (const window of ["hour", "day", "week", "month"]) {
			expect(parseApiKeyLimit(`window=${window},usd=5`)).toEqual({
				window,
				limitUsd: 5,
				scopeModel: null,
				enforce: "block",
			});
		}
		expect(parseApiKeyLimit("model=opus,warn,usd=0.25,window=day")).toEqual({
			window: "day",
			limitUsd: 0.25,
			scopeModel: "opus",
			enforce: "warn",
		});
	});

	it.each([
		"window=day",
		"window=year,usd=5",
		"window=day,usd=0",
		"window=day,usd=-5",
		"window=day,usd=Infinity",
		"window=day,usd=NaN",
		"window=day,usd=5,usd=6",
		"window=day,usd=5,unknown=x",
		"window=day,usd=5,warn=true",
		"window=day,usd=5,model=",
		"window=day,usd=5,model=bad model",
	])("rejects invalid limit %s", (value) => {
		expect(() => parseApiKeyLimit(value)).toThrow();
	});

	it("parses mode and routing without accepting unknown families", () => {
		expect(parseApiKeyLimitMode("calendar")).toBe("calendar");
		expect(parseApiKeyLimitMode("rolling")).toBe("rolling");
		expect(() => parseApiKeyLimitMode("utc")).toThrow();
		expect(parseApiKeyRouting("opus=codex-combo")).toEqual([
			"opus",
			"codex-combo",
		]);
		expect(() => parseApiKeyRouting("__proto__=combo")).toThrow();
		expect(() => parseApiKeyRouting("opus=")).toThrow();
	});

	it("validates duplicate scopes and combo references before making changes", async () => {
		const db = { getCombo: async () => null } as unknown as DatabaseOperations;
		await expect(
			validateApiKeyOptions(db, {
				limits: [
					parseApiKeyLimit("window=day,usd=1"),
					parseApiKeyLimit("window=day,usd=2"),
				],
			}),
		).rejects.toThrow("Duplicate");
		await expect(
			validateApiKeyOptions(db, { familyComboOverrides: { opus: "missing" } }),
		).rejects.toThrow("not found");
		await expect(
			validateApiKeyOptions(db, {
				restrictions: { allowedProviders: ["missing"] },
			}),
		).rejects.toThrow("Unknown provider");
	});

	it("validates account IDs and model scopes before changing a key", async () => {
		let writes = 0;
		const db = {
			getAllAccounts: async () => [
				{
					id: "configured-account",
					provider: "openai-compatible",
					model_mappings:
						'{"opus":"custom-model {\\"only\\":[\\"provider\\"]}"}',
				},
			],
			listCombos: async () => [{ id: "combo" }],
			getComboSlots: async () => [
				{ model: "pinned-local-model" },
				{ model: "" },
			],
			getApiKey: async () => ({ id: "key" }),
			replaceApiKeyLimits: async () => {
				writes++;
				return true;
			},
			updateApiKeyRestrictions: async () => {
				writes++;
				return true;
			},
		} as unknown as DatabaseOperations;
		await expect(
			configureApiKey(db, "key", {
				restrictions: { allowedAccounts: ["missing"] },
			}),
		).rejects.toThrow("Unknown account");
		await expect(
			configureApiKey(db, "key", {
				limits: [parseApiKeyLimit("window=day,usd=5,model=opuz")],
			}),
		).rejects.toThrow("Unknown model scope");
		expect(writes).toBe(0);
		for (const scope of [
			"opus",
			"claude-opus-4-6",
			"custom-model",
			"pinned-local-model",
		]) {
			await validateApiKeyOptions(db, {
				restrictions: { allowedAccounts: ["configured-account"] },
				limits: [parseApiKeyLimit(`window=day,usd=5,model=${scope}`)],
			});
		}
	});

	it("accepts native provider defaults, bundled models and global overrides without fetching", async () => {
		const previous = getProviderModelDefaultOverrides();
		const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("CLI model validation must stay offline"),
		);
		const db = {
			getAllAccounts: async () => [{ id: "minimax", provider: "minimax" }],
			listCombos: async () => [],
		} as unknown as DatabaseOperations;
		try {
			setProviderModelDefaultOverrides({
				codex: { opus: "global-codex-model" },
			});
			for (const scope of [
				"MiniMax-M2.7",
				"MiniMax-M2",
				"global-codex-model",
			]) {
				await validateApiKeyOptions(db, {
					limits: [parseApiKeyLimit(`window=day,usd=5,model=${scope}`)],
				});
			}
			await expect(
				validateApiKeyOptions(db, {
					limits: [parseApiKeyLimit("window=day,usd=5,model=MiniMax-typo")],
				}),
			).rejects.toThrow("Unknown model scope");
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			setProviderModelDefaultOverrides(previous);
			fetch.mockRestore();
		}
	});

	it("updates one restriction without clearing the other restrictions", async () => {
		let saved: unknown;
		const db = {
			getApiKey: async () => ({
				id: "key",
				allowedAccounts: ["account"],
				allowedModels: ["haiku"],
				allowedProviders: ["codex"],
			}),
			updateApiKeyRestrictions: async (_id: string, restrictions: unknown) => {
				saved = restrictions;
				return true;
			},
		} as unknown as DatabaseOperations;
		await configureApiKey(db, "key", {
			restrictions: { allowedModels: ["opus"] },
		});
		expect(saved).toEqual({
			allowedAccounts: ["account"],
			allowedModels: ["opus"],
			allowedProviders: ["codex"],
		});
	});

	it("changing mode retains rows; clearing limits and routing is explicit", async () => {
		const writes: unknown[] = [];
		const limits = [parseApiKeyLimit("window=day,usd=5,model=opus")];
		const db = {
			getApiKey: async () => ({ id: "key", limitWindowMode: "calendar" }),
			getApiKeyLimits: async () => limits,
			replaceApiKeyLimits: async (...args: unknown[]) => {
				writes.push(args);
				return true;
			},
			updateApiKeyRouting: async (...args: unknown[]) => {
				writes.push(args);
				return true;
			},
		} as unknown as DatabaseOperations;
		await configureApiKey(db, "key", { limitMode: "rolling" });
		expect(writes[0]).toEqual(["key", limits, "rolling"]);
		await configureApiKey(db, "key", {
			limits: [],
			familyComboOverrides: null,
		});
		expect(writes[1]).toEqual(["key", [], "calendar"]);
		expect(writes[2]).toEqual(["key", null]);
	});

	it.each([
		"restrictions",
		"limits",
		"routing",
	])("removes a newly generated key when applying %s fails", async (failure) => {
		let saved: { id: string } | undefined;
		let createdId: string | undefined;
		const deleted: string[] = [];
		const db = {
			apiKeyNameExists: async () => false,
			countActiveApiKeys: async () => 1,
			createApiKey: async (key: { id: string }) => {
				saved = key;
				createdId = key.id;
			},
			getApiKey: async () => saved,
			getCombo: async () => ({ id: "combo" }),
			updateApiKeyRestrictions: async () => failure !== "restrictions",
			replaceApiKeyLimits: async () => failure !== "limits",
			updateApiKeyRouting: async () => {
				if (failure === "routing") throw new Error("routing write failed");
				return true;
			},
			deleteApiKey: async (id: string) => {
				deleted.push(id);
				saved = undefined;
				return true;
			},
		} as unknown as DatabaseOperations;
		await expect(
			generateConfiguredApiKey(db, "new key", "api-only", {
				restrictions: { allowedModels: ["opus"] },
				limits: [parseApiKeyLimit("window=day,usd=5")],
				familyComboOverrides: { opus: "combo" },
			}),
		).rejects.toThrow(
			failure === "routing"
				? "routing write failed"
				: `Failed to update API key ${failure}`,
		);
		expect(createdId).toBeDefined();
		expect(deleted).toEqual([createdId]);
		expect(saved).toBeUndefined();
	});

	it("validates options before generating a key", async () => {
		const create = spyOn({ create: async () => {} }, "create");
		const db = {
			getCombo: async () => null,
			createApiKey: create,
		} as unknown as DatabaseOperations;
		await expect(
			generateConfiguredApiKey(db, "new key", "api-only", {
				familyComboOverrides: { opus: "missing" },
			}),
		).rejects.toThrow("not found");
		expect(create).not.toHaveBeenCalled();
	});

	it("returns the generated secret after saving every setting without deleting the key", async () => {
		const writes: string[] = [];
		let saved: { id: string } | undefined;
		const db = {
			apiKeyNameExists: async () => false,
			createApiKey: async (key: { id: string }) => {
				saved = key;
				writes.push("create");
			},
			getApiKey: async () => saved,
			getCombo: async () => ({ id: "combo" }),
			updateApiKeyRestrictions: async () => {
				writes.push("restrictions");
				return true;
			},
			replaceApiKeyLimits: async () => {
				writes.push("limits");
				return true;
			},
			updateApiKeyRouting: async () => {
				writes.push("routing");
				return true;
			},
			deleteApiKey: async () => {
				writes.push("delete");
				return true;
			},
		} as unknown as DatabaseOperations;
		const result = await generateConfiguredApiKey(db, "new key", "admin", {
			restrictions: { allowedModels: ["opus"] },
			limits: [parseApiKeyLimit("window=day,usd=5")],
			familyComboOverrides: { opus: "combo" },
		});
		expect(writes).toEqual(["create", "restrictions", "limits", "routing"]);
		expect(result.id).toBe(saved?.id);
		expect(result.apiKey.slice(-8)).toBe(result.prefixLast8);
	});

	it.each([
		"limits",
		"routing",
	])("leaves no key or limits after a SQLite %s write fails", async (failure) => {
		const previousUrl = process.env.DATABASE_URL;
		delete process.env.DATABASE_URL;
		const db = new DatabaseOperations(":memory:", undefined, { attempts: 1 });
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const sqlite = db.getAdapter().getSQLiteDb();
			sqlite.run(
				"INSERT INTO combos (id,name,created_at,updated_at) VALUES ('combo','combo',1,1)",
			);
			sqlite.run(
				failure === "limits"
					? "CREATE TRIGGER fail_config BEFORE INSERT ON api_key_limits BEGIN SELECT RAISE(ABORT, 'limit write failed'); END"
					: "CREATE TRIGGER fail_config BEFORE UPDATE OF family_combo_overrides ON api_keys BEGIN SELECT RAISE(ABORT, 'routing write failed'); END",
			);
			await expect(
				generateConfiguredApiKey(db, "new key", "admin", {
					restrictions: { allowedModels: ["opus"] },
					limits: [parseApiKeyLimit("window=day,usd=5")],
					familyComboOverrides: { opus: "combo" },
				}),
			).rejects.toThrow(
				`${failure === "limits" ? "limit" : "routing"} write failed`,
			);
			expect(sqlite.query("SELECT COUNT(*) AS n FROM api_keys").get()).toEqual({
				n: 0,
			});
			expect(
				sqlite.query("SELECT COUNT(*) AS n FROM api_key_limits").get(),
			).toEqual({ n: 0 });
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			await db.close();
			if (previousUrl === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previousUrl;
		}
	});

	it.each([
		false,
		"delete failed",
	])("reports the configuration error when cleanup returns %s", async (cleanup) => {
		const failure = new Error("configuration failed");
		const db = {
			apiKeyNameExists: async () => false,
			createApiKey: async () => {},
			getApiKey: async () => {
				throw failure;
			},
			deleteApiKey: async () => {
				if (cleanup) throw new Error(cleanup);
				return false;
			},
		} as unknown as DatabaseOperations;
		const error = await generateConfiguredApiKey(
			db,
			"new key",
			"admin",
			{},
		).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			"configuration failed; failed to remove newly created API key '",
		);
		expect((error as Error).cause).toBe(failure);
	});
});
