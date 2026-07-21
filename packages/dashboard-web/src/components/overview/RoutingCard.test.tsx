/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	getStrategySelectItems,
	RoutingCardView,
	type RoutingCardViewProps,
	type StrategySelectItem,
} from "./RoutingCard";

function render(overrides: Partial<RoutingCardViewProps> = {}): string {
	const props: RoutingCardViewProps = {
		strategy: "session",
		onStrategyChange: () => {},
		strategyDisabled: false,
		strategySource: "default",
		capacityMode: "off",
		capacitySource: "default",
		onCapacityChange: () => {},
		capacityDisabled: false,
		...overrides,
	};
	return renderToStaticMarkup(<RoutingCardView {...props} />);
}

describe("RoutingCardView", () => {
	it("renders both the strategy selector and the capacity switch", () => {
		const html = render();
		// The strategy Select renders as a Radix combobox trigger.
		expect(html).toContain('role="combobox"');
		expect(html).toContain("Load-balancing strategy");
		// The capacity control renders as a Radix switch.
		expect(html).toContain('role="switch"');
		expect(html).toContain("Model-scoped capacity routing");
	});

	it("explains the drain-soonest tiebreaker in the strategy description", () => {
		const html = render();
		expect(html).toContain("priority becomes a tiebreaker");
		// The safety note about not offering per-request spreading strategies.
		expect(html).toContain("Only session-class strategies are shown");
	});

	it("reflects the exhausted capacity mode as a checked switch", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "file" });
		expect(html).toContain('aria-checked="true"');
	});

	it("reflects the off capacity mode as an unchecked switch", () => {
		const html = render({ capacityMode: "off", capacitySource: "file" });
		expect(html).toContain('aria-checked="false"');
	});

	it("locks the switch and shows an env-locked badge when the source is env", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "env" });
		expect(html).toContain("env-locked");
		// Radix marks a disabled switch with data-disabled; the strategy select is
		// enabled here, so this uniquely proves the switch itself is disabled.
		expect(html).toContain("data-disabled");
		// Badge tooltip points the user at the overriding env var.
		expect(html).toContain("MODEL_SCOPED_CAPACITY_ROUTING");
	});

	it("locks the switch off and shows an env-locked badge when mode is off and source is env", () => {
		const html = render({ capacityMode: "off", capacitySource: "env" });
		expect(html).toContain('aria-checked="false"');
		expect(html).toContain("data-disabled");
		expect(html).toContain("env-locked");
	});

	it("leaves the switch enabled and hides the badge for the file source", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "file" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("leaves the switch enabled and hides the badge for the default source", () => {
		const html = render({
			capacityMode: "exhausted",
			capacitySource: "default",
		});
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("locks the strategy select and shows an env-locked badge when strategySource is env", () => {
		const html = render({ strategy: "session", strategySource: "env" });
		expect(html).toContain("env-locked");
		// The capacity switch is enabled here (default "default" source), so
		// this uniquely proves the strategy select itself is disabled.
		expect(html).toContain("data-disabled");
		// Badge tooltip points the user at the overriding env var.
		expect(html).toContain("LB_STRATEGY");
	});

	it("leaves the strategy select enabled and hides its badge for the file source", () => {
		const html = render({ strategy: "session", strategySource: "file" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("leaves the strategy select enabled and hides its badge for the default source", () => {
		const html = render({ strategy: "session", strategySource: "default" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("associates the strategy label with its Select trigger via htmlFor/id", () => {
		const html = render();
		expect(html).toContain('for="routing-strategy"');
		expect(html).toContain('id="routing-strategy"');
	});

	it("associates the capacity label with its Switch via htmlFor/id", () => {
		const html = render();
		expect(html).toContain('for="routing-capacity"');
		expect(html).toContain('id="routing-capacity"');
	});

	it("does not throw when the effective strategy is not one of the listed options", () => {
		// least-used/session-affinity are valid StrategyName values that are
		// deliberately not offered (see STRATEGY_OPTIONS), but the server can
		// still report them as the effective strategy (env/config/older
		// default). The view must render without error in that case.
		const html = render({ strategy: "least-used" });
		expect(html).toContain('role="combobox"');
	});
});

describe("getStrategySelectItems", () => {
	const listed: readonly StrategySelectItem[] = [
		{ label: "Session", value: "session" },
		{ label: "Session — drain soonest", value: "session-drain-soonest" },
	];

	it("returns only the two listed options when the current strategy is one of them", () => {
		expect(getStrategySelectItems("session")).toEqual(listed);
		expect(getStrategySelectItems("session-drain-soonest")).toEqual(listed);
	});

	it("appends the current strategy as a disabled item when it is not listed", () => {
		expect(getStrategySelectItems("least-used")).toEqual([
			...listed,
			{ label: "least-used (current)", value: "least-used", disabled: true },
		]);
	});

	it("appends session-affinity as a disabled item when it is the current strategy", () => {
		expect(getStrategySelectItems("session-affinity")).toEqual([
			...listed,
			{
				label: "session-affinity (current)",
				value: "session-affinity",
				disabled: true,
			},
		]);
	});
});
