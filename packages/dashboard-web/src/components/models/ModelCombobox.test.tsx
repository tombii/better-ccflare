/*
 * This bun test environment has no DOM library (no testing-library /
 * happy-dom): components are rendered to static markup, and the write path is
 * exercised through the same core helpers the handlers call. ModelCombobox
 * has no hooks that need a QueryClient (the list hook is pinned to its
 * loading state), so it renders outside a provider.
 */
import { describe, expect, it, mock } from "bun:test";
import {
	formatModelRouting,
	type ModelRouting,
	splitModelRouting,
} from "@better-ccflare/core";
import { renderToStaticMarkup } from "react-dom/server";
import { formatModelList, parseModelList } from "../../lib/model-api";
import { providerSupportsInferenceProviderRouting } from "../../utils/provider-utils";
import {
	ModelCombobox,
	type ModelComboboxProps,
	nextListAfterPick,
} from "./ModelCombobox";
import {
	addRoutingSlug,
	applyRoutingMode,
	ModelRoutingPanel,
	type ModelRoutingPanelProps,
	type RoutingMode,
	routingModeOf,
	summarizeRouting,
} from "./ModelRoutingPanel";

// The model list query needs a QueryClient; the toggle under test does not.
mock.module("../../hooks/useProviderModels", () => ({
	useProviderModels: () => ({
		data: undefined,
		isLoading: false,
		isError: false,
		error: null,
	}),
}));

const TOGGLE = "Edit upstream provider routing";
const BARE = "deepseek/deepseek-v4.1-flash-1017";

function renderCombobox(overrides: Partial<ModelComboboxProps>): string {
	const props: ModelComboboxProps = {
		provider: null,
		value: "",
		onChange: () => {},
		...overrides,
	};
	return renderToStaticMarkup(<ModelCombobox {...props} />);
}

function renderPanel(overrides: Partial<ModelRoutingPanelProps> = {}): string {
	const props: ModelRoutingPanelProps = {
		provider: "openrouter",
		routing: null,
		onChange: () => {},
		...overrides,
	};
	return renderToStaticMarkup(<ModelRoutingPanel {...props} />);
}

/** What a handler produces: attach (or clear) the routing of one model. */
function withRouting(value: string, routing: ModelRouting | null): string {
	return formatModelRouting(splitModelRouting(value).model, routing);
}

describe("ModelCombobox provider routing toggle", () => {
	it("appears for openrouter and nanogpt", () => {
		for (const provider of ["openrouter", "nanogpt"]) {
			expect(renderCombobox({ provider })).toContain(TOGGLE);
		}
	});

	it("is absent for providers without provider routing", () => {
		for (const provider of ["anthropic", "codex", "zai", null]) {
			expect(renderCombobox({ provider })).not.toContain(TOGGLE);
		}
	});

	it("keeps the full suffix in the input value", () => {
		const value = `${BARE} {"only":["deepseek"]}`;
		const html = renderCombobox({ provider: "openrouter", value });
		// React escapes the quotes in the attribute.
		expect(html).toContain(`${BARE} {&quot;only&quot;`);
	});
});

describe("providerSupportsInferenceProviderRouting", () => {
	it("delegates to the provider list in core", () => {
		expect(providerSupportsInferenceProviderRouting("openrouter")).toBe(true);
		expect(providerSupportsInferenceProviderRouting("nanogpt")).toBe(true);
		expect(providerSupportsInferenceProviderRouting("anthropic")).toBe(false);
		expect(providerSupportsInferenceProviderRouting(undefined)).toBe(false);
	});
});

describe("ModelRoutingPanel", () => {
	it("offers the three modes and shows the slugs and fallbacks when pinned", () => {
		const html = renderPanel({ routing: { only: ["deepseek"] } });
		expect(html).toContain("Any provider");
		expect(html).toContain("Only these");
		expect(html).toContain("Exclude these");
		expect(html).toContain("deepseek");
	});

	it("shows sort and fallbacks for excludes but not for a single pin", () => {
		const pinned = renderPanel({ routing: { only: ["deepseek"] } });
		expect(pinned).not.toContain("Allow fallbacks");
		expect(pinned).not.toContain("Sort");
		const excluded = renderPanel({ routing: { ignore: ["deepseek"] } });
		expect(excluded).toContain("Allow fallbacks");
		expect(excluded).toContain("Sort");
	});

	it("hides the slug input and fallbacks in any-provider mode", () => {
		const html = renderPanel({ routing: null });
		expect(html).not.toContain("Allow fallbacks");
		expect(html).not.toContain("Add upstream provider slug");
	});

	it("warns about NanoGPT pay-as-you-go billing only when pinned", () => {
		const warning = "billed pay-as-you-go and does not use this account";
		expect(
			renderPanel({ provider: "nanogpt", routing: { only: ["deepseek"] } }),
		).toContain(warning);
		expect(renderPanel({ provider: "nanogpt", routing: null })).not.toContain(
			warning,
		);
		expect(
			renderPanel({ provider: "openrouter", routing: { only: ["deepseek"] } }),
		).not.toContain(warning);
	});

	it("is disabled with a hint when the list has no element", () => {
		const html = renderPanel({
			segments: { labels: [], index: 0, onSelect: () => {} },
			emptyHint: "Add a model to the list first",
		});
		expect(html).toContain("Add a model to the list first");
		expect(html).toContain("<fieldset disabled");
	});

	it("shows one segment per list element, current one highlighted", () => {
		const html = renderPanel({
			segments: {
				labels: ["model-a", "model-b"],
				index: 1,
				onSelect: () => {},
			},
		});
		expect(html).toContain("model-a");
		expect(html).toContain("model-b");
		expect(html).toContain("bg-primary text-primary-foreground");
	});

	it("derives the mode and the compact summary", () => {
		expect(routingModeOf(null)).toBe("any");
		expect(routingModeOf({ only: ["deepseek"] })).toBe("only");
		expect(routingModeOf({ ignore: ["novita"] })).toBe("ignore");
		expect(routingModeOf({ sort: "price" })).toBe("any");
		expect(summarizeRouting({ only: ["deepseek"] })).toBe("only: deepseek");
		expect(summarizeRouting({ ignore: ["deepseek", "novita"] })).toBe(
			"exclude: deepseek, novita",
		);
		expect(summarizeRouting(null)).toBe("");
	});
});

/** The panel's own handlers: mode radio, then adding a slug. */
function edit(value: string, mode: RoutingMode, slugs: string[]): string {
	const { routing } = splitModelRouting(value);
	let next = applyRoutingMode(routing, mode);
	for (const slug of slugs) next = addRoutingSlug(next, mode, slug);
	return withRouting(value, next);
}

describe("routing write-through", () => {
	it('"Only these" + deepseek writes the JSON suffix', () => {
		expect(edit(BARE, "only", ["deepseek"])).toBe(
			`${BARE} {"only":["deepseek"]}`,
		);
	});

	it('"Exclude these" + novita writes an ignore list', () => {
		expect(edit(BARE, "ignore", ["novita"])).toBe(
			`${BARE} {"ignore":["novita"]}`,
		);
	});

	it("normalises and de-duplicates slugs", () => {
		let routing = applyRoutingMode(null, "only");
		routing = addRoutingSlug(routing, "only", " DeepSeek ");
		routing = addRoutingSlug(routing, "only", "deepseek");
		expect(routing).toEqual({ only: ["deepseek"] });
	});

	it("commits an empty mode choice as no routing at all", () => {
		expect(applyRoutingMode(null, "only")).toBeNull();
		expect(
			applyRoutingMode(
				{ only: ["deepseek"], sort: "price", allow_fallbacks: false },
				"any",
			),
		).toBeNull();
	});

	it('switching to "Only these" emits only `only`', () => {
		expect(
			applyRoutingMode(
				{ ignore: ["novita"], sort: "price", allow_fallbacks: false },
				"only",
			),
		).toBeNull();
		expect(
			applyRoutingMode({ only: ["deepseek"], sort: "latency" }, "only"),
		).toEqual({ only: ["deepseek"] });
	});

	it('"Any provider" restores the bare model', () => {
		expect(edit(`${BARE} {"only":["deepseek"]}`, "any", [])).toBe(BARE);
	});

	it("list mode edits only the current element", () => {
		const list = parseModelList(formatModelList([BARE, "qwen/qwen3-coder"]));
		const edited = list.map((m, i) =>
			i === 1 ? edit(m, "ignore", ["novita"]) : m,
		);
		expect(formatModelList(edited)).toBe(
			`${BARE}, qwen/qwen3-coder {"ignore":["novita"]}`,
		);
	});
});

describe("list pick keeps per-element state", () => {
	it("toggles on the stripped model and removes it", () => {
		const pinned = `${BARE} {"only":["deepseek"]}`;
		expect(nextListAfterPick([pinned, "qwen/q"], BARE)).toEqual(["qwen/q"]);
		expect(nextListAfterPick(["qwen/q"], "a/b")).toEqual(["qwen/q", "a/b"]);
	});
});

describe("single-mode pick preserves the routing of the same model", () => {
	it("re-picking the current model keeps its pin", () => {
		const value = `${BARE} {"only":["deepseek"]}`;
		const { model: current, routing } = splitModelRouting(value);
		expect(formatModelRouting(BARE, current === BARE ? routing : null)).toBe(
			value,
		);
	});
});
