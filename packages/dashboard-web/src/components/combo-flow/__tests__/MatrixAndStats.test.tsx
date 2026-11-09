import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComboFlowCombo } from "../../../api";
import { MatrixAndStats } from "../MatrixAndStats";
import { RecentRequests } from "../RecentRequests";

function mkCombo(over: Partial<ComboFlowCombo> = {}): ComboFlowCombo {
	return {
		id: "c1",
		name: "Main",
		description: null,
		enabled: true,
		familyCount: 1,
		slots: [
			{
				id: "s1",
				accountId: "acc-1",
				accountName: "alpha",
				provider: "anthropic",
				model: "",
				priority: 0,
				enabled: true,
				cooldownUntil: null,
				available: true,
			},
			{
				id: "s2",
				accountId: "acc-2",
				accountName: "beta",
				provider: "ollama",
				model: "glm-4.5",
				priority: 1,
				enabled: false,
				cooldownUntil: null,
				available: true,
			},
		],
		stats: {
			requests: 10,
			successRate: 0.9,
			failoverRequests: 2,
			avgResponseMs: 1500,
			errorTop: [
				{ status: 429, error: "rate limited", accountId: "acc-1", count: 1 },
			],
			pairings: [
				{
					originalModel: "claude-sonnet-4-5",
					appliedModel: "glm-4.5",
					servedModel: "glm-4.5",
					account: "alpha",
					count: 7,
					successRate: 1,
				},
				{
					originalModel: null,
					appliedModel: null,
					servedModel: "claude-haiku-4-5",
					account: null,
					count: 3,
					successRate: 0.6667,
				},
			],
		},
		...over,
	};
}

describe("MatrixAndStats", () => {
	it("renders stat tiles, the resolution matrix and the slot definition", () => {
		const html = renderToStaticMarkup(<MatrixAndStats combo={mkCombo()} />);
		expect(html).toContain("24h requests");
		expect(html).toContain(">10<");
		expect(html).toContain("90.0%");
		expect(html).toContain("2"); // failover reqs
		expect(html).toContain("1.5s");
		// Matrix rows.
		expect(html).toContain("claude-sonnet-4-5");
		expect(html).toContain("glm-4.5");
		expect(html).toContain("66.7%");
		expect(html).toContain("—"); // null original/applied/account render as em dash
		// Slot definition rows.
		expect(html).toContain("passthrough");
		expect(html).toContain("disabled");
		expect(html).toContain("ollama");
		// Top errors, with the account id resolved to the slot's name.
		expect(html).toContain("rate limited");
		expect(html).toContain("429 × 1 · alpha · rate limited");
	});

	it("shows an empty-matrix message and no error section when there is no data", () => {
		const html = renderToStaticMarkup(
			<MatrixAndStats
				combo={mkCombo({
					slots: [],
					stats: {
						requests: 0,
						successRate: null,
						failoverRequests: 0,
						avgResponseMs: null,
						errorTop: [],
						pairings: [],
					},
				})}
			/>,
		);
		expect(html).toContain("No combo-tagged requests in the last 24h");
		expect(html).toContain("No slots.");
		expect(html).not.toContain("Top errors");
	});
});

describe("RecentRequests", () => {
	const summary = (id: string, over: Record<string, unknown> = {}) =>
		({
			id,
			timestamp: "2026-11-09T10:00:00.000Z",
			method: "POST",
			path: "/v1/messages",
			accountUsed: "alpha",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTimeMs: 1200,
			failoverAttempts: 1,
			comboName: "Main",
			originalModel: "claude-sonnet-4-5",
			appliedModel: "glm-4.5",
			...over,
		}) as never;

	it("renders the model rewrite, account, status and timing per row", () => {
		const html = renderToStaticMarkup(
			<RecentRequests requests={[summary("r1")]} />,
		);
		expect(html).toContain("Only requests routed through this combo");
		expect(html).toContain("claude-sonnet-4-5 → glm-4.5");
		expect(html).toContain("alpha");
		expect(html).toContain("200");
		expect(html).toContain("1.2s");
	});

	it("shows the served model for a combo-pinned row with no agent rewrite", () => {
		// A slot pin never sets originalModel/appliedModel; only `model` (the
		// upstream's reported model) carries it.
		const html = renderToStaticMarkup(
			<RecentRequests
				requests={[
					summary("r2", {
						originalModel: undefined,
						appliedModel: undefined,
						model: "claude-haiku-4-5",
					}),
				]}
			/>,
		);
		expect(html).toContain("— → claude-haiku-4-5");
	});

	it("caps rows at the limit and shows an empty message", () => {
		const many = Array.from({ length: 20 }, (_, i) => summary(`r${i}`));
		const html = renderToStaticMarkup(
			<RecentRequests requests={many} limit={15} />,
		);
		expect((html.match(/claude-sonnet-4-5 → glm-4.5/g) ?? []).length).toBe(15);

		const empty = renderToStaticMarkup(<RecentRequests requests={[]} />);
		expect(empty).toContain("No recent requests through this combo");
	});
});
