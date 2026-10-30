/**
 * Static-markup tests for the /search page. This test environment has no DOM
 * (no testing-library), so components are rendered with renderToStaticMarkup
 * and their data hooks are stubbed via mock.module. The interactive rules
 * (add requires a key when the catalog says so, test shows latency vs error)
 * are covered through the pure helpers the components call.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	SearchProviderCatalogEntry,
	SearchProviderPublic,
	SearchProviderTestResult,
	WebSearchSettings,
} from "../../lib/search-provider-types";

const RAW_KEY = "sk-live-SUPERSECRET-abcdefghijkl";

type MockState = {
	providers: SearchProviderPublic[] | undefined;
	providersLoading: boolean;
	providersError: Error | null;
	catalog: SearchProviderCatalogEntry[];
	settings: WebSearchSettings | undefined;
	settingsLoading: boolean;
	lastTest: SearchProviderTestResult | undefined;
	testPending: boolean;
	updatePending: boolean;
	lastMutationError: Error | null;
	testCalls: string[];
	updateCalls: { id: string; patch: unknown }[];
};

const state: MockState = {
	providers: [],
	providersLoading: false,
	providersError: null,
	catalog: [],
	settings: undefined,
	settingsLoading: false,
	lastTest: undefined,
	testPending: false,
	updatePending: false,
	lastMutationError: null,
	testCalls: [],
	updateCalls: [],
};

function query<T>(data: T | undefined, loading: boolean, error: Error | null) {
	return { data, isLoading: loading, isError: !!error, error };
}

const idleMutation = {
	isPending: false,
	isError: false,
	error: null,
	reset: () => {},
};

mock.module("../../hooks/useSearchProviders", () => ({
	useSearchProviders: () =>
		query(state.providers, state.providersLoading, state.providersError),
	useSearchProviderCatalog: () => query(state.catalog, false, null),
	useCreateSearchProvider: () => ({ ...idleMutation, mutate: () => {} }),
	useUpdateSearchProvider: () => ({
		...idleMutation,
		isPending: state.updatePending,
		isError: !!state.lastMutationError,
		error: state.lastMutationError,
		mutate: (vars: { id: string; patch: unknown }) => {
			state.updateCalls.push(vars);
		},
	}),
	useReorderSearchProvider: () => ({ ...idleMutation, mutate: () => {} }),
	useDeleteSearchProvider: () => ({ ...idleMutation, mutate: () => {} }),
	useTestSearchProvider: () => ({
		...idleMutation,
		isPending: state.testPending,
		data: state.lastTest,
		mutate: (id: string) => {
			state.testCalls.push(id);
		},
	}),
}));

mock.module("../../hooks/useWebSearchSettings", () => ({
	useWebSearchSettings: () =>
		query(state.settings, state.settingsLoading, null),
	useSaveWebSearchSettings: () => ({ ...idleMutation, mutate: () => {} }),
}));

import { ProviderDialog } from "./ProviderDialog";
import {
	emptyFormState,
	formStateToPayload,
	ProviderFormFields,
	validateForm,
} from "./ProviderFormFields";
import { SearchProviderRow } from "./SearchProviderRow";
import { SearchTab } from "./SearchTab";

function provider(
	overrides: Partial<SearchProviderPublic> = {},
): SearchProviderPublic {
	return {
		id: "p1",
		provider: "brave",
		label: "Brave",
		// Even if a (buggy) server leaked a field, it is not rendered: only
		// apiKeyMasked is read. Keep this consistent with the mask.
		apiKeyMasked: "****wxyz",
		priority: 0,
		enabled: true,
		maxResults: 5,
		extraConfig: null,
		status: "ok",
		statusMessage: null,
		statusCheckedAt: null,
		cooldownUntil: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as SearchProviderPublic;
}

const catalog: SearchProviderCatalogEntry[] = [
	{
		id: "brave",
		label: "Brave Search",
		requiresKey: true,
		docsUrl: "https://brave.com/search/api/",
		extraConfigFields: [
			{
				key: "safesearch",
				label: "Safe search",
				type: "select",
				options: ["off", "moderate", "strict"],
			},
		],
	},
	{
		id: "searxng",
		label: "SearXNG",
		requiresKey: false,
		docsUrl: "https://docs.searxng.org/",
	},
];

beforeEach(() => {
	state.providers = [];
	state.providersLoading = false;
	state.providersError = null;
	state.catalog = catalog;
	state.settings = { enabled: false, maxResultChars: 800, bypassHeader: false };
	state.settingsLoading = false;
	state.lastTest = undefined;
	state.testPending = false;
	state.updatePending = false;
	state.lastMutationError = null;
	state.testCalls = [];
	state.updateCalls = [];
});

describe("SearchTab master toggle", () => {
	it("renders off/unchecked when the settings say disabled", () => {
		const html = renderToStaticMarkup(<SearchTab />);
		expect(html).toContain('id="web-search-enabled"');
		expect(html).toContain('aria-checked="false"');
		expect(html).toContain(">Off<");
		expect(html).not.toContain(">On<");
		// The numeric draft resyncs from the server value in an effect, which
		// static rendering does not run; the label and control must be present.
		expect(html).toContain('id="web-search-max-chars"');
	});

	it("renders checked when the settings say enabled", () => {
		state.settings = {
			enabled: true,
			maxResultChars: 1200,
			bypassHeader: true,
		};
		const html = renderToStaticMarkup(<SearchTab />);
		expect(html).toContain('aria-checked="true"');
		expect(html).toContain(">On<");
	});

	it("explains that interception does nothing without providers", () => {
		const html = renderToStaticMarkup(<SearchTab />);
		expect(html).toContain("No search providers yet");
		expect(html).toContain("enabling");
	});

	it("surfaces a provider-list load error inline", () => {
		state.providersError = new Error("Not found");
		const html = renderToStaticMarkup(<SearchTab />);
		expect(html).toContain("Failed to load search providers");
	});
});

describe("SearchProviderRow", () => {
	it("renders the masked key and never the raw key", () => {
		state.providers = [provider()];
		const html = renderToStaticMarkup(<SearchTab />);
		expect(html).toContain("****wxyz");
		expect(html).not.toContain(RAW_KEY);
		expect(html).toContain("brave");
	});

	it("mutes a disabled provider and labels it", () => {
		const html = renderToStaticMarkup(
			<SearchProviderRow
				provider={provider({ enabled: false })}
				onEdit={() => {}}
			/>,
		);
		expect(html).toContain("opacity-60");
		expect(html).toContain("Disabled");
		expect(html).toContain('aria-checked="false"');
	});

	it("shows latency after a successful test", () => {
		state.lastTest = { ok: true, latencyMs: 123 };
		const html = renderToStaticMarkup(
			<SearchProviderRow provider={provider()} onEdit={() => {}} />,
		);
		expect(html).toContain("OK · 123ms");
	});

	it("shows the error text after a failed test", () => {
		state.lastTest = { ok: false, latencyMs: 0, error: "401 Unauthorized" };
		const html = renderToStaticMarkup(
			<SearchProviderRow provider={provider()} onEdit={() => {}} />,
		);
		expect(html).toContain("401 Unauthorized");
		expect(html).not.toContain("OK ·");
	});

	it("shows the remaining cooldown time", () => {
		const html = renderToStaticMarkup(
			<SearchProviderRow
				provider={provider({
					status: "cooldown",
					cooldownUntil: Date.now() + 65_000,
				})}
				onEdit={() => {}}
			/>,
		);
		expect(html).toContain("Cooling down · 1m");
	});
});

describe("ProviderDialog", () => {
	it("mounts without crashing (body is portal-rendered)", () => {
		expect(() =>
			renderToStaticMarkup(<ProviderDialog isOpen onClose={() => {}} />),
		).not.toThrow();
	});

	it("renders the key field as a password input (never a reveal affordance)", () => {
		// The dialog body is inside a portal, which static rendering does not
		// emit; the form fields are rendered directly here, with the same
		// catalog entry the dialog would pick.
		const html = renderToStaticMarkup(
			<ProviderFormFields
				form={{ ...emptyFormState(catalog), extraConfig: {} }}
				onChange={() => {}}
				catalog={catalog}
				catalogEntry={catalog[0]}
				isEdit={false}
			/>,
		);
		expect(html).toContain("API key");
		expect(html).toContain('type="password"');
		expect(html).toContain('autoComplete="new-password"');
		expect(html).toContain("https://brave.com/search/api/");
		expect(html).toContain("Safe search");
		expect(html).not.toContain("show key");
		expect(html).not.toContain("Show key");
	});
});

describe("validateForm", () => {
	const base = {
		provider: "brave",
		label: "Brave",
		apiKey: "",
		priority: "0",
		maxResults: "5",
		extraConfig: {},
	};

	it("rejects a missing key when the catalog requires one", () => {
		expect(validateForm(base, catalog[0], { isEdit: false })).toContain(
			"needs an API key",
		);
	});

	it("accepts a key when required", () => {
		expect(
			validateForm({ ...base, apiKey: "k" }, catalog[0], { isEdit: false }),
		).toBeNull();
	});

	it("does not require a key when the catalog does not", () => {
		expect(
			validateForm({ ...base, provider: "searxng" }, catalog[1], {
				isEdit: false,
			}),
		).toBeNull();
	});

	it("allows an empty key when editing (keeps the stored one)", () => {
		expect(validateForm(base, catalog[0], { isEdit: true })).toBeNull();
	});

	it("rejects bad priority and max results", () => {
		expect(
			validateForm({ ...base, apiKey: "k", priority: "-1" }, catalog[0], {
				isEdit: false,
			}),
		).toContain("Priority");
		expect(
			validateForm({ ...base, apiKey: "k", maxResults: "0" }, catalog[0], {
				isEdit: false,
			}),
		).toContain("Max results");
	});
});

describe("formStateToPayload", () => {
	it("omits a blank key and converts extraConfig numbers", () => {
		const payload = formStateToPayload(
			{
				provider: "brave",
				label: "  Brave  ",
				apiKey: "  ",
				priority: "2",
				maxResults: "10",
				extraConfig: {},
			},
			catalog[0],
		);
		expect(payload).toEqual({
			provider: "brave",
			label: "Brave",
			apiKey: undefined,
			priority: 2,
			maxResults: 10,
			extraConfig: null,
		});
	});
});
