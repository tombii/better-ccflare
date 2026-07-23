import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_KEYS = ["BETTER_CCFLARE_OUTBOUND_PROXY"] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
	ORIGINAL_ENV[key] = process.env[key];
}

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("outbound proxy config setting", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const original = ORIGINAL_ENV[key];
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	});

	it("returns undefined when unset everywhere", () => {
		delete process.env.BETTER_CCFLARE_OUTBOUND_PROXY;
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getOutboundProxy()).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("returns the env var value, with trailing slash stripped", () => {
		process.env.BETTER_CCFLARE_OUTBOUND_PROXY = "http://127.0.0.1:3636/";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getOutboundProxy()).toBe("http://127.0.0.1:3636");
		} finally {
			cleanup();
		}
	});

	it("returns the config-file value when the env var is unset", () => {
		delete process.env.BETTER_CCFLARE_OUTBOUND_PROXY;
		const { config, cleanup } = makeConfig();

		try {
			config.set("outbound_proxy", "http://proxy.example.com:8080");
			expect(config.getOutboundProxy()).toBe("http://proxy.example.com:8080");
		} finally {
			cleanup();
		}
	});

	it("prefers the env var over the config-file value", () => {
		process.env.BETTER_CCFLARE_OUTBOUND_PROXY = "http://127.0.0.1:3636";
		const { config, cleanup } = makeConfig();

		try {
			config.set("outbound_proxy", "http://proxy.example.com:8080");
			expect(config.getOutboundProxy()).toBe("http://127.0.0.1:3636");
		} finally {
			cleanup();
		}
	});

	it("returns undefined for an invalid URL instead of throwing", () => {
		process.env.BETTER_CCFLARE_OUTBOUND_PROXY = "not-a-url";
		const { config, cleanup } = makeConfig();

		try {
			expect(() => config.getOutboundProxy()).not.toThrow();
			expect(config.getOutboundProxy()).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("returns undefined for a disallowed protocol instead of throwing", () => {
		process.env.BETTER_CCFLARE_OUTBOUND_PROXY = "ftp://example.com";
		const { config, cleanup } = makeConfig();

		try {
			expect(() => config.getOutboundProxy()).not.toThrow();
			expect(config.getOutboundProxy()).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});
