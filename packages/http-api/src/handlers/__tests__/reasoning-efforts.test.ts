import { afterEach, describe, expect, it } from "bun:test";
import { REASONING_EFFORTS_ENV_VAR } from "@better-ccflare/config";
import {
	getReasoningEffortOverrides,
	setReasoningEffortOverrides,
} from "@better-ccflare/openai-formats";
import { createConfigHandlers } from "../config";

type Overrides = Record<string, string[]>;

const ORIGINAL_ENV = process.env[REASONING_EFFORTS_ENV_VAR];

afterEach(() => {
	if (ORIGINAL_ENV === undefined) {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
	} else {
		process.env[REASONING_EFFORTS_ENV_VAR] = ORIGINAL_ENV;
	}
	setReasoningEffortOverrides(null);
});

/**
 * Stub Config that mirrors the real precedence: a non-blank env var wins over
 * the config-file map. `setCalls` records every setter invocation so a test can
 * assert the file was never written.
 */
function makeConfig(file: Overrides = {}) {
	let saved = structuredClone(file);
	const setCalls: Overrides[] = [];
	const config = {
		getReasoningEffortOverrides: () => {
			const fromEnv = process.env[REASONING_EFFORTS_ENV_VAR];
			if (fromEnv?.trim()) return JSON.parse(fromEnv) as Overrides;
			return structuredClone(saved);
		},
		setReasoningEffortOverrides: (value: Overrides) => {
			setCalls.push(structuredClone(value));
			saved = structuredClone(value);
		},
	} as unknown as import("@better-ccflare/config").Config;
	return { config, setCalls };
}

function request(body: unknown): Request {
	return new Request("http://localhost/api/config/reasoning-efforts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

interface Payload {
	success: boolean;
	data: {
		overrides: Overrides;
		source: "env" | "file" | "default";
		envVarSet: boolean;
	};
}

describe("reasoning-effort overrides API", () => {
	it("GET reports defaults when neither env nor file supplies a map", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const { config } = makeConfig();
		const handlers = createConfigHandlers(config);

		const body = (await handlers.getReasoningEfforts().json()) as Payload;

		expect(body).toEqual({
			success: true,
			data: { overrides: {}, source: "default", envVarSet: false },
		});
	});

	it("GET reports the config-file map as source 'file'", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const file = { "grok-4.7-build-fast": ["low", "high"] };
		const { config } = makeConfig(file);
		const handlers = createConfigHandlers(config);

		const body = (await handlers.getReasoningEfforts().json()) as Payload;

		expect(body.data.source).toBe("file");
		expect(body.data.envVarSet).toBe(false);
		expect(body.data.overrides).toEqual(file);
	});

	it("GET reports 'env' and the env value when the var wins over the file", async () => {
		process.env[REASONING_EFFORTS_ENV_VAR] = JSON.stringify({
			"env-model": ["minimal", "high"],
		});
		const { config } = makeConfig({ "file-model": ["low"] });
		const handlers = createConfigHandlers(config);

		const body = (await handlers.getReasoningEfforts().json()) as Payload;

		expect(body.data.source).toBe("env");
		expect(body.data.envVarSet).toBe(true);
		expect(body.data.overrides).toEqual({ "env-model": ["minimal", "high"] });
	});

	it("POST replaces the map and updates the live openai-formats registry", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const { config, setCalls } = makeConfig();
		const handlers = createConfigHandlers(config);
		const overrides = { "grok-4.7-build-fast": ["low", "high"] };

		const response = await handlers.setReasoningEfforts(request({ overrides }));

		expect(response.status).toBe(200);
		const body = (await response.json()) as Payload;
		expect(body).toEqual({
			success: true,
			data: { overrides, source: "file", envVarSet: false },
		});
		expect(setCalls).toEqual([overrides]);
		expect(getReasoningEffortOverrides()).toEqual(overrides);
	});

	it("POST {} clears the map", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const { config, setCalls } = makeConfig({ "old-model": ["low"] });
		const handlers = createConfigHandlers(config);
		setReasoningEffortOverrides({ "old-model": ["low"] });

		const response = await handlers.setReasoningEfforts(
			request({ overrides: {} }),
		);

		expect(response.status).toBe(200);
		expect(setCalls).toEqual([{}]);
		expect(getReasoningEffortOverrides()).toEqual({});
	});

	it("POST rejects an unknown level with 400 and names the allowed values", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const { config, setCalls } = makeConfig();
		const handlers = createConfigHandlers(config);

		const response = await handlers.setReasoningEfforts(
			request({ overrides: { m: ["extreme"] } }),
		);

		expect(response.status).toBe(400);
		const raw = await response.text();
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(raw).toContain(level);
		}
		expect(setCalls).toEqual([]);
	});

	it("POST rejects a non-array value with 400", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const { config, setCalls } = makeConfig();
		const handlers = createConfigHandlers(config);

		const response = await handlers.setReasoningEfforts(
			request({ overrides: { m: "low" } }),
		);

		expect(response.status).toBe(400);
		expect(setCalls).toEqual([]);
	});

	it("POST rejects a non-string level with 400", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const { config, setCalls } = makeConfig();
		const handlers = createConfigHandlers(config);

		const response = await handlers.setReasoningEfforts(
			request({ overrides: { m: ["low", 3] } }),
		);

		expect(response.status).toBe(400);
		expect(setCalls).toEqual([]);
	});

	it("POST rejects a missing 'overrides' object with 400", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const { config, setCalls } = makeConfig();
		const handlers = createConfigHandlers(config);

		const response = await handlers.setReasoningEfforts(request({}));

		expect(response.status).toBe(400);
		expect(setCalls).toEqual([]);
	});

	it("POST rejects a non-object body with 400", async () => {
		delete process.env[REASONING_EFFORTS_ENV_VAR];
		const { config, setCalls } = makeConfig();
		const handlers = createConfigHandlers(config);

		const asArray = await handlers.setReasoningEfforts(request([]));
		expect(asArray.status).toBe(400);

		const asString = await handlers.setReasoningEfforts(request("nope"));
		expect(asString.status).toBe(400);

		const asNull = await handlers.setReasoningEfforts(request(null));
		expect(asNull.status).toBe(400);

		expect(setCalls).toEqual([]);
	});

	it("POST answers 409 when the env var outranks the file, without writing", async () => {
		process.env[REASONING_EFFORTS_ENV_VAR] = JSON.stringify({
			"env-model": ["low"],
		});
		const { config, setCalls } = makeConfig();
		const handlers = createConfigHandlers(config);

		const response = await handlers.setReasoningEfforts(
			request({ overrides: { m: ["high"] } }),
		);

		expect(response.status).toBe(409);
		const body = (await response.json()) as { error?: string };
		expect(body.error).toContain(REASONING_EFFORTS_ENV_VAR);
		expect(setCalls).toEqual([]);
		expect(getReasoningEffortOverrides()).toEqual({});
	});
});
