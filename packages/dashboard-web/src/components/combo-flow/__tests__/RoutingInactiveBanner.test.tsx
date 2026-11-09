import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	RoutingInactiveBanner,
	routingOffReason,
} from "../RoutingInactiveBanner";

describe("RoutingInactiveBanner", () => {
	it("explains that the chains are hypothetical when combos are disabled", () => {
		const html = renderToStaticMarkup(
			<RoutingInactiveBanner
				routing={{ combosEnabled: false, forceAccountModel: false }}
			/>,
		);
		expect(html).toContain("Combo routing is not active right now");
		expect(html).toContain("normal pool routing");
		expect(html).toContain("WOULD route");
		// The tooltip names the concrete reason, not just "inactive".
		expect(html).toContain(
			'title="Combo routing is inactive: combos are disabled"',
		);
	});

	it("names both switches when both are in play", () => {
		expect(
			routingOffReason({ combosEnabled: false, forceAccountModel: true }),
		).toBe("combos are disabled and 'force account model' is on");
		expect(
			routingOffReason({ combosEnabled: true, forceAccountModel: true }),
		).toBe("'force account model' is on");
		expect(
			routingOffReason({ combosEnabled: false, forceAccountModel: false }),
		).toBe("combos are disabled");
	});
});
