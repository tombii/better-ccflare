import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	ComboFlowCombo,
	ComboFlowFamily,
	ComboFlowSlot,
} from "../../../api";
import { FamilyFlowCard } from "../FamilyFlowCard";

const NOW = 1_700_000_000_000;

function mkSlot(over: Partial<ComboFlowSlot> = {}): ComboFlowSlot {
	return {
		id: "s1",
		accountId: "acc-1",
		accountName: "alpha",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		passthrough: false,
		priority: 0,
		enabled: true,
		cooldownUntil: null,
		available: true,
		...over,
	};
}

function mkCombo(over: Partial<ComboFlowCombo> = {}): ComboFlowCombo {
	return {
		id: "c1",
		name: "Main",
		description: null,
		enabled: true,
		familyCount: 1,
		slots: [
			mkSlot(),
			mkSlot({
				id: "s2",
				accountId: "acc-2",
				accountName: "beta",
				provider: "ollama",
				model: "",
				passthrough: true,
				priority: 1,
			}),
		],
		recentRequests: [],
		stats: {
			requests: 0,
			successRate: null,
			failoverRequests: 0,
			avgResponseMs: null,
			errorTop: [],
			pairings: [],
		},
		...over,
	};
}

function mkFamily(over: Partial<ComboFlowFamily> = {}): ComboFlowFamily {
	return {
		family: "sonnet",
		assignmentEnabled: false,
		combo: null,
		observation: null,
		...over,
	};
}

describe("FamilyFlowCard", () => {
	it("shows normal pool routing for an unassigned family", () => {
		const html = renderToStaticMarkup(
			<FamilyFlowCard family={mkFamily()} combo={null} now={NOW} />,
		);
		expect(html).toContain("Sonnet");
		expect(html).toContain("No combo assigned —");
		expect(html).toContain("normal pool routing");
		expect(html).toContain('href="/combos"');
		expect(html).not.toContain("Combo:");
	});

	it("shows the assignment-disabled message when a combo exists but is turned off", () => {
		const html = renderToStaticMarkup(
			<FamilyFlowCard
				family={mkFamily({
					assignmentEnabled: false,
					combo: { id: "c1", name: "Main", enabled: true },
				})}
				combo={mkCombo()}
				now={NOW}
			/>,
		);
		expect(html).toContain("Assignment disabled —");
	});

	it("renders the chain: family → combo → slots with names and the passthrough label", () => {
		const html = renderToStaticMarkup(
			<FamilyFlowCard
				family={mkFamily({
					assignmentEnabled: true,
					combo: { id: "c1", name: "Main", enabled: true },
				})}
				combo={mkCombo()}
				now={NOW}
			/>,
		);
		expect(html).toContain("Combo: Main");
		expect(html).toContain("enabled");
		expect(html).toContain("alpha");
		expect(html).toContain("claude-sonnet-4-5");
		expect(html).toContain("beta");
		expect(html).toContain("passthrough");
		expect(html).toContain("anthropic");
		expect(html).toContain("ollama");
		// No observation yet → explicit message, no "last picked" state.
		expect(html).toContain("No routing decision observed");
	});

	it("marks a cooling slot with a cooling badge and the account observation as last picked", () => {
		const cooldownUntil = NOW + 65_000;
		const html = renderToStaticMarkup(
			<FamilyFlowCard
				family={mkFamily({
					assignmentEnabled: true,
					combo: { id: "c1", name: "Main", enabled: false },
					observation: {
						model: "claude-sonnet-4-5",
						order: [
							{ id: "acc-1", name: "alpha" },
							{ id: "acc-2", name: "beta" },
						],
						observedAtMs: NOW - 12_000,
					},
				})}
				combo={mkCombo({
					enabled: false,
					slots: [
						mkSlot({ cooldownUntil, available: false }),
						mkSlot({ id: "s2", accountId: "acc-2", accountName: "beta" }),
					],
				})}
				now={NOW}
			/>,
		);
		expect(html).toContain("Cooling ·");
		expect(html).toContain("Z</div>"); // UTC clock suffix
		expect(html).toContain("observed 12s ago");
		expect(html).toContain("disabled"); // combo badge
		// The rank-1 pill (the last-picked account) is the highlighted one.
		expect(html).toContain("bg-primary text-primary-foreground");
		expect(html).not.toContain("No routing decision observed");
	});

	it("distinguishes an unavailable account from a missing one", () => {
		const html = renderToStaticMarkup(
			<FamilyFlowCard
				family={mkFamily({
					assignmentEnabled: true,
					combo: { id: "c1", name: "Main", enabled: true },
				})}
				combo={mkCombo({
					slots: [
						mkSlot({ available: false }),
						mkSlot({
							id: "s2",
							accountId: "acc-gone",
							accountName: null,
							available: false,
						}),
					],
				})}
				now={NOW}
			/>,
		);
		// Paused/rate-limited account: exists, but the selector skips it.
		expect(html).toContain("unavailable");
		// Slot references an account that was deleted: a different problem.
		expect(html).toContain("account missing");
	});

	it("falls back to a message when the assigned combo no longer exists", () => {
		const html = renderToStaticMarkup(
			<FamilyFlowCard
				family={mkFamily({
					assignmentEnabled: true,
					combo: { id: "gone", name: "Ghost", enabled: true },
				})}
				combo={null}
				now={NOW}
			/>,
		);
		expect(html).toContain("Assigned combo no longer exists");
	});

	it("marks the card with a muted routing-off badge when combo routing is inactive", () => {
		const html = renderToStaticMarkup(
			<FamilyFlowCard
				family={mkFamily({
					assignmentEnabled: true,
					combo: { id: "c1", name: "Main", enabled: true },
				})}
				combo={mkCombo()}
				now={NOW}
				routingActive={false}
			/>,
		);
		expect(html).toContain("routing off");
		expect(html).toContain("what would route if combos were enabled");
	});

	it("does not show the routing-off badge while combo routing is active", () => {
		const html = renderToStaticMarkup(
			<FamilyFlowCard
				family={mkFamily({
					assignmentEnabled: true,
					combo: { id: "c1", name: "Main", enabled: true },
				})}
				combo={mkCombo()}
				now={NOW}
			/>,
		);
		expect(html).not.toContain("routing off");
	});

	it("shows model-dependent cooling badges on a passthrough slot with model cooldowns", () => {
		const html = renderToStaticMarkup(
			<FamilyFlowCard
				family={mkFamily({
					assignmentEnabled: true,
					combo: { id: "c1", name: "Main", enabled: true },
				})}
				combo={mkCombo({
					slots: [
						mkSlot({
							id: "s1",
							model: "",
							passthrough: true,
							// No single deadline: "" never matches a cooldown key.
							cooldownUntil: null,
							cooldowns: [
								{ model: "glm-4.5-air", until: NOW + 60_000 },
								{ model: "glm-4.5", until: NOW + 120_000 },
								{ model: "glm-4.6", until: NOW + 180_000 },
							],
						}),
					],
				})}
				now={NOW}
			/>,
		);
		expect((html.match(/Cooling \(model-dependent\)/g) ?? []).length).toBe(2);
		expect(html).toContain("glm-4.5-air");
		expect(html).toContain("glm-4.5");
		// Only two cooldown badges inline; the rest collapse into a +n badge.
		expect(html).not.toContain("glm-4.6 ·");
		expect(html).toContain("+1");
		expect(html).toContain("availability depends on the requested model");
		// Still available — the skip is model-dependent, not definite.
		expect(html).not.toContain(">unavailable<");
	});
});
