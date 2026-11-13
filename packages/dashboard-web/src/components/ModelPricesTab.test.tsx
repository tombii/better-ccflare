import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ApiKeysTab } from "./ApiKeysTab";
import { ApiKeyLimitsEditor } from "./api-keys/ApiKeyLimitsEditor";
import { ApiKeyRestrictionsEditor } from "./api-keys/ApiKeyRestrictionsEditor";
import { ApiKeySpendLimitEditor } from "./api-keys/ApiKeySpendLimitEditor";
import { NO_SPEND_LIMIT } from "./api-keys/spend-limit";
import { ModelPriceHint, ModelPricesTab } from "./ModelPricesTab";

function renderPrices(children: React.ReactNode, enabled = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(["model-prices"], {
		currency: "USD",
		unit: "per_million_tokens",
		models: [
			{
				id: "claude-opus-4-6",
				name: "Opus 4.6",
				provider: "anthropic",
				family: "opus",
				rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			},
			{
				id: "unpriced",
				name: "No known price",
				provider: "other",
				family: "other",
				rates: null,
			},
		],
	});
	client.setQueryData(["cost-tracking"], { enabled, source: "default" });
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<MemoryRouter>{children}</MemoryRouter>
			</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}

describe("model prices view and shared hints", () => {
	it("renders a searchable catalogue with family, all token rates, and unknown prices", () => {
		const markup = renderPrices(<ModelPricesTab />);
		expect(markup).toContain('aria-label="Search model prices"');
		expect(markup).toContain("USD per 1M tokens");
		for (const text of [
			"Opus 4.6",
			"opus",
			"$5",
			"$25",
			"$0.5",
			"$6.25",
			"Cache read",
			"Cache write",
			"No price available",
		])
			expect(markup).toContain(text);
	});
	it("uses the same catalogue for a concrete scope and a family hint", () => {
		for (const scope of ["claude-opus-4-6", "opus"]) {
			const markup = renderPrices(<ModelPriceHint scope={scope} />);
			expect(markup).toContain(
				"$5 in / $25 out / $0.5 cache-read / $6.25 cache-write per 1M tokens (USD)",
			);
		}
	});
	it("embeds catalogue prices next to model and family choices in the create-key restrictions form", () => {
		const markup = renderPrices(
			<ApiKeyRestrictionsEditor
				idPrefix="new-key"
				value={{
					allowedModels: ["opus"],
					allowedAccounts: null,
					allowedProviders: null,
				}}
				onChange={() => {}}
			/>,
		);
		expect(markup).toContain("Families");
		expect(markup).toContain(
			"$5 in / $25 out / $0.5 cache-read / $6.25 cache-write",
		);
	});
	it("embeds prices in the create-key spend section and next to the scoped limit field", () => {
		const create = renderPrices(
			<ApiKeySpendLimitEditor
				idPrefix="new-key"
				value={NO_SPEND_LIMIT}
				onChange={() => {}}
			/>,
		);
		expect(create).toContain(
			"$5 in / $25 out / $0.5 cache-read / $6.25 cache-write",
		);
		const edit = renderPrices(
			<ApiKeyLimitsEditor
				keyId="key"
				limits={[
					{
						id: "limit",
						apiKeyId: "key",
						scopeModel: "opus",
						window: "day",
						limitUsd: 5,
						enforce: "block",
						createdAt: 0,
						updatedAt: 0,
						spentUsd: 0,
						resetsAt: "",
					},
				]}
			/>,
		);
		expect(edit).toContain("Model scope");
		expect(edit).toContain(
			"$5 in / $25 out / $0.5 cache-read / $6.25 cache-write",
		);
	});
	it("warns that limits cannot be enforced when cost tracking is disabled", () => {
		for (const form of [
			<ApiKeysTab key="list" />,
			<ApiKeySpendLimitEditor
				key="create"
				idPrefix="new-key"
				value={NO_SPEND_LIMIT}
				onChange={() => {}}
			/>,
			<ApiKeyLimitsEditor key="edit" keyId="key" limits={[]} />,
		]) {
			const markup = renderPrices(form, false);
			expect(markup).toContain("Cost tracking is disabled");
			expect(markup).toContain("Spend limits are not enforced");
		}
	});
});
