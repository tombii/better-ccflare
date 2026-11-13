import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	configureApiKey,
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
});
