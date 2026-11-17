import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../../api";
import { AccountAddForm } from "./AccountAddForm";

// No DOM environment is configured for dashboard-web (no happy-dom/jsdom, no
// @testing-library), and Radix's SelectContent is not mounted while the select
// is closed, so the sailresearch option and its conditional API-key field are
// asserted on the source, while the create path is exercised through the API
// client that the form calls.

const noop = async () => {};

const baseProps = {
	onAddAccount: async () => ({ authUrl: "", sessionId: "" }),
	onCompleteAccount: noop,
	onAddZaiAccount: noop,
	onAddMinimaxAccount: noop,
	onAddDeepseekAccount: noop,
	onAddSailResearchAccount: noop,
	onAddOpencodeGoAccount: noop,
	onAddAnthropicCompatibleAccount: noop,
	onAddNanoGPTAccount: noop,
	onAddOpenAIAccount: noop,
	onAddVertexAIAccount: noop,
	onAddBedrockAccount: noop,
	onAddAlibabaCodingPlanAccount: noop,
	onAddKiloAccount: noop,
	onAddOpenRouterAccount: noop,
	onAddOllamaAccount: noop,
	onAddOllamaCloudAccount: noop,
	onAddMetaAccount: noop,
	onCancel: () => {},
	onSuccess: () => {},
	onError: () => {},
};

const sourcePath = new URL("./AccountAddForm.tsx", import.meta.url).pathname;

describe("AccountAddForm sailresearch", () => {
	it("offers a Sail Research option next to DeepSeek", async () => {
		const source = await Bun.file(sourcePath).text();
		expect(source).toContain('<SelectItem value="sailresearch">');
		expect(source).toContain("Sail Research (API Key)");
		expect(source).toContain('"sailresearch"');
	});

	it("guards the Sail Research API key field on the sailresearch mode", async () => {
		const source = await Bun.file(sourcePath).text();
		expect(source).toMatch(
			/newAccount\.mode === "sailresearch" && \(\s*<div className="space-y-2">\s*<Label htmlFor="apiKey">Sail Research API Key<\/Label>/,
		);
	});

	it("submits via onAddSailResearchAccount, not the OAuth flow, in sailresearch mode", async () => {
		const source = await Bun.file(sourcePath).text();
		const branch = source.slice(
			source.indexOf('if (newAccount.mode === "sailresearch")'),
			source.indexOf('if (newAccount.mode === "nanogpt")'),
		);
		expect(branch).toContain("await onAddSailResearchAccount({");
		expect(branch).toContain("API key is required for Sail Research accounts");
		expect(branch).not.toContain("onAddAccount(");
	});

	it("renders without a Sail Research field in the default mode", () => {
		const html = renderToStaticMarkup(createElement(AccountAddForm, baseProps));
		expect(html).toContain("Add New Account");
		expect(html).not.toContain("Sail Research API Key");
	});
});

describe("AccountAddForm opencode-go", () => {
	it("offers an OpenCode Go option", async () => {
		const source = await Bun.file(sourcePath).text();
		expect(source).toContain('<SelectItem value="opencode-go">');
		expect(source).toContain("OpenCode Go (API Key)");
		expect(source).toContain('"opencode-go"');
	});

	it("guards the OpenCode Go API key field on the opencode-go mode", async () => {
		const source = await Bun.file(sourcePath).text();
		expect(source).toMatch(
			/newAccount\.mode === "opencode-go" && \(\s*<div className="space-y-2">\s*<Label htmlFor="apiKey">OpenCode Go API Key<\/Label>/,
		);
	});

	it("submits via onAddOpencodeGoAccount, not the OAuth flow, in opencode-go mode", async () => {
		const source = await Bun.file(sourcePath).text();
		const start = source.indexOf('if (newAccount.mode === "opencode-go")');
		expect(start).toBeGreaterThan(-1);
		const branch = source.slice(start, start + 1500);
		expect(branch).toContain("await onAddOpencodeGoAccount({");
		expect(branch).toContain("API key is required for OpenCode Go accounts");
		expect(branch).not.toContain("onAddAccount(");
	});

	it("renders without an OpenCode Go field in the default mode", () => {
		const html = renderToStaticMarkup(createElement(AccountAddForm, baseProps));
		expect(html).not.toContain("OpenCode Go API Key");
	});
});

describe("api.addOpencodeGoAccount", () => {
	const originalFetch = globalThis.fetch;
	const originalLocalStorage = (globalThis as { localStorage?: unknown })
		.localStorage;
	let fetchCalls: Array<{ url: string; body: unknown }>;

	beforeEach(() => {
		fetchCalls = [];
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		};
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				fetchCalls.push({
					url: String(input),
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
				});
				return new Response(JSON.stringify({ success: true, accountId: "a" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		(globalThis as { localStorage?: unknown }).localStorage =
			originalLocalStorage;
		mock.restore();
	});

	it("creates the account through the generic /api/accounts route with mode opencode-go", async () => {
		await api.addOpencodeGoAccount({
			name: "go-1",
			apiKey: "sk-go",
			priority: 5,
		});
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("/api/accounts");
		expect(fetchCalls[0]?.body).toEqual({
			name: "go-1",
			apiKey: "sk-go",
			priority: 5,
			mode: "opencode-go",
		});
	});
});

describe("api.addSailResearchAccount", () => {
	const originalFetch = globalThis.fetch;
	const originalLocalStorage = (globalThis as { localStorage?: unknown })
		.localStorage;
	let fetchCalls: Array<{ url: string; body: unknown }>;

	beforeEach(() => {
		fetchCalls = [];
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		};
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				fetchCalls.push({
					url: String(input),
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
				});
				return new Response(JSON.stringify({ success: true, accountId: "a" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		(globalThis as { localStorage?: unknown }).localStorage =
			originalLocalStorage;
		mock.restore();
	});

	it("creates the account through the generic /api/accounts route with mode sailresearch", async () => {
		await api.addSailResearchAccount({
			name: "sail-1",
			apiKey: "sk-sail",
			priority: 5,
		});
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("/api/accounts");
		expect(fetchCalls[0]?.body).toEqual({
			name: "sail-1",
			apiKey: "sk-sail",
			priority: 5,
			mode: "sailresearch",
		});
	});
});
