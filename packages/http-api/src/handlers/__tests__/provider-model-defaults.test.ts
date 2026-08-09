import { afterEach, describe, expect, it } from "bun:test";
import { PROVIDER_MODEL_DEFAULTS_ENV_VAR } from "@better-ccflare/config";
import {
	resolveProviderModelDefault,
	setProviderModelDefaultOverrides,
} from "@better-ccflare/providers";
import { createConfigHandlers } from "../config";

function makeConfig(initial: Record<string, Record<string, string>> = {}) {
	let saved = initial;
	return {
		getProviderModelDefaultOverrides: () => structuredClone(saved),
		setProviderModelDefaultOverrides: (
			value: Record<string, Record<string, string>>,
		) => {
			saved = structuredClone(value);
		},
		getEnabledProviderModelDefaultProviders: () => {
			const fromEnv = process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;
			if (fromEnv) {
				const parsed = fromEnv
					.split(",")
					.map((provider) => provider.trim())
					.filter(Boolean);
				if (parsed.length > 0) return parsed;
			}
			return ["codex"];
		},
	} as unknown as import("@better-ccflare/config").Config;
}

function request(overrides: unknown): Request {
	return new Request("http://localhost/api/config/provider-model-defaults", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ overrides }),
	});
}

const ORIGINAL_MODEL_DEFAULTS_PROVIDERS_ENV =
	process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;

afterEach(() => {
	setProviderModelDefaultOverrides({});
	if (ORIGINAL_MODEL_DEFAULTS_PROVIDERS_ENV === undefined) {
		delete process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;
	} else {
		process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS =
			ORIGINAL_MODEL_DEFAULTS_PROVIDERS_ENV;
	}
});

describe("provider model defaults", () => {
	it("merges one family override without erasing the provider factory map", async () => {
		const handlers = createConfigHandlers(makeConfig());
		const response = await handlers.setProviderModelDefaults(
			request([{ provider: "codex", family: "opus", model: "gpt-custom" }]),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			providers: Array<{
				provider: string;
				fields: Array<{ family: string; effective: string }>;
			}>;
		};
		const codex = body.providers.find(
			(provider) => provider.provider === "codex",
		)!;
		expect(
			codex.fields.find((field) => field.family === "opus")?.effective,
		).toBe("gpt-custom");
		expect(
			codex.fields.find((field) => field.family === "haiku")?.effective,
		).toBe("gpt-5.4-mini");
	});

	it("empty model removes an override and resolver returns factory", async () => {
		const handlers = createConfigHandlers(
			makeConfig({ codex: { opus: "gpt-custom" } }),
		);
		setProviderModelDefaultOverrides({ codex: { opus: "gpt-custom" } });
		const response = await handlers.setProviderModelDefaults(
			request([{ provider: "codex", family: "opus", model: "" }]),
		);
		expect(response.status).toBe(200);
		expect(resolveProviderModelDefault("codex", "opus")).toBe("gpt-5.3-codex");
	});

	it("rejects unknown providers and families", async () => {
		const handlers = createConfigHandlers(makeConfig());
		expect(
			(
				await handlers.setProviderModelDefaults(
					request([{ provider: "nope", family: "opus", model: "x" }]),
				)
			).status,
		).toBe(400);
		// `fable` now exists in the codex map; the nonexistent family is
		// now another one, and `fable` must be ACCEPTED.
		expect(
			(
				await handlers.setProviderModelDefaults(
					request([{ provider: "codex", family: "inexistente", model: "x" }]),
				)
			).status,
		).toBe(400);
		expect(
			(
				await handlers.setProviderModelDefaults(
					request([
						{ provider: "codex", family: "fable", model: "gpt-5.6-sol" },
					]),
				)
			).status,
		).toBe(200);
	});

	it("resolver returns factory when no override exists", () => {
		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-4.3");
	});

	it("GET lists only codex by default (CCFLARE_MODEL_DEFAULTS_PROVIDERS unset)", async () => {
		delete process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;
		const handlers = createConfigHandlers(makeConfig());
		const response = handlers.getProviderModelDefaults();
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			providers: Array<{ provider: string }>;
		};
		expect(body.providers.map((provider) => provider.provider)).toEqual([
			"codex",
		]);
	});

	it("POST rejects a disabled provider with 400 citing the env var", async () => {
		delete process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;
		const handlers = createConfigHandlers(makeConfig());
		const response = await handlers.setProviderModelDefaults(
			request([{ provider: "xai", family: "sonnet", model: "grok-x" }]),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error?: string };
		expect(JSON.stringify(body)).toContain(PROVIDER_MODEL_DEFAULTS_ENV_VAR);
		expect(JSON.stringify(body)).toContain("xai");
	});

	it("CCFLARE_MODEL_DEFAULTS_PROVIDERS=codex,xai lists and accepts xai again", async () => {
		process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS = "codex,xai";
		const handlers = createConfigHandlers(makeConfig());
		const getBody = (await handlers.getProviderModelDefaults().json()) as {
			providers: Array<{ provider: string }>;
		};
		expect(
			getBody.providers.map((provider) => provider.provider).sort(),
		).toEqual(["codex", "xai"]);

		const response = await handlers.setProviderModelDefaults(
			request([{ provider: "xai", family: "sonnet", model: "grok-x" }]),
		);
		expect(response.status).toBe(200);
		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-x");
	});

	it("a disabled provider's stored override stays inert and does not affect resolution", async () => {
		process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS = "codex,xai";
		const config = makeConfig({ xai: { sonnet: "grok-custom" } });
		const handlers = createConfigHandlers(config);
		// A POST to codex already pushes the whole map (filtered by enabled
		// providers) to the in-memory registry, just as boot does.
		await handlers.setProviderModelDefaults(
			request([{ provider: "codex", family: "opus", model: "gpt-custom" }]),
		);
		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-custom");

		process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS = "codex";
		await handlers.setProviderModelDefaults(
			request([{ provider: "codex", family: "opus", model: "gpt-custom" }]),
		);
		expect(resolveProviderModelDefault("xai", "sonnet")).toBe("grok-4.3");
	});

	it("codex keeps translating even when left out of CCFLARE_MODEL_DEFAULTS_PROVIDERS", async () => {
		process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS = "xai";
		const handlers = createConfigHandlers(makeConfig());
		const response = await handlers.setProviderModelDefaults(
			request([{ provider: "codex", family: "opus", model: "gpt-custom" }]),
		);
		expect(response.status).toBe(400);
		expect(resolveProviderModelDefault("codex", "opus")).toBe("gpt-5.3-codex");
	});
});
