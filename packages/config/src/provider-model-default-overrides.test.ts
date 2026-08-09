import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, filterEnabledProviderModelDefaultOverrides } from "./index";

describe("provider model default overrides", () => {
	it("keeps only non-empty provider-family overrides", () => {
		const directory = mkdtempSync(join(tmpdir(), "ccflare-provider-defaults-"));
		const path = join(directory, "config.json");
		try {
			writeFileSync(
				path,
				JSON.stringify({
					provider_model_default_overrides: {
						codex: { opus: "gpt-custom", haiku: "" },
					},
				}),
			);
			const config = new Config(path);
			expect(config.getProviderModelDefaultOverrides()).toEqual({
				codex: { opus: "gpt-custom" },
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("provider model default enabled providers (CCFLARE_MODEL_DEFAULTS_PROVIDERS)", () => {
	const ORIGINAL_ENV = process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;

	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;
		} else {
			process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS = ORIGINAL_ENV;
		}
	});

	function makeConfig(initial: Record<string, Record<string, string>> = {}) {
		const directory = mkdtempSync(
			join(tmpdir(), "ccflare-provider-defaults-enabled-"),
		);
		const path = join(directory, "config.json");
		writeFileSync(
			path,
			JSON.stringify({ provider_model_default_overrides: initial }),
		);
		return {
			config: new Config(path),
			cleanup: () => rmSync(directory, { recursive: true, force: true }),
		};
	}

	it("defaults to only codex when the env var is absent or blank", () => {
		delete process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getEnabledProviderModelDefaultProviders()).toEqual([
				"codex",
			]);
		} finally {
			cleanup();
		}

		process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS = "  ,  ";
		const { config: blankConfig, cleanup: cleanupBlank } = makeConfig();
		try {
			expect(blankConfig.getEnabledProviderModelDefaultProviders()).toEqual([
				"codex",
			]);
		} finally {
			cleanupBlank();
		}
	});

	it("parses a trimmed comma-separated list when the env var is set", () => {
		process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS = "codex, xai ,qwen";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getEnabledProviderModelDefaultProviders()).toEqual([
				"codex",
				"xai",
				"qwen",
			]);
		} finally {
			cleanup();
		}
	});
});

describe("filterEnabledProviderModelDefaultOverrides", () => {
	it("drops overrides for providers outside the enabled set without mutating the input", () => {
		const overrides = {
			codex: { opus: "gpt-custom" },
			xai: { sonnet: "grok-custom" },
		};
		const filtered = filterEnabledProviderModelDefaultOverrides(
			["codex"],
			overrides,
		);
		expect(filtered).toEqual({ codex: { opus: "gpt-custom" } });
		// A entrada do provider desabilitado permanece no mapa original.
		expect(overrides.xai).toEqual({ sonnet: "grok-custom" });
	});

	it("brings a previously-disabled provider back once it is enabled", () => {
		const overrides = {
			codex: { opus: "gpt-custom" },
			xai: { sonnet: "grok-custom" },
		};
		expect(
			filterEnabledProviderModelDefaultOverrides(["codex", "xai"], overrides),
		).toEqual(overrides);
	});
});
