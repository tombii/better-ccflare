/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutingCardView, type RoutingCardViewProps } from "./RoutingCard";

function render(overrides: Partial<RoutingCardViewProps> = {}): string {
	const props: RoutingCardViewProps = {
		strategy: "session",
		onStrategyChange: () => {},
		strategyDisabled: false,
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
});
