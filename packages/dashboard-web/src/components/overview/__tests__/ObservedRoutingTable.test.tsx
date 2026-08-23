import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoutingObservation } from "../../../api";
import { ObservedRoutingTable } from "../ObservedRoutingTable";

const NOW = 1_700_000_000_000;

function mkObservation(
	family: string,
	names: string[],
	observedAtMs: number,
): RoutingObservation {
	return {
		family,
		order: names.map((name, i) => ({ id: `id-${i}`, name })),
		model: `claude-${family}`,
		observedAtMs,
	};
}

describe("ObservedRoutingTable", () => {
	it("renders nothing when there are no observations at all", () => {
		expect(
			renderToStaticMarkup(
				<ObservedRoutingTable observations={undefined} now={NOW} />,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<ObservedRoutingTable observations={null} now={NOW} />,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<ObservedRoutingTable observations={{}} now={NOW} />,
			),
		).toBe("");
	});

	it("renders every observed family, including one that also has its own pool row (fable)", () => {
		const html = renderToStaticMarkup(
			<ObservedRoutingTable
				observations={{
					fable: mkObservation("fable", ["acc-fable"], NOW - 1000),
					sonnet: mkObservation("sonnet", ["acc-b", "acc-a"], NOW - 65_000),
					opus: mkObservation("opus", ["acc-c"], NOW - 5000),
				}}
				now={NOW}
			/>,
		);
		expect(html).toContain(
			"Observed routing order — the last decision the proxy actually made",
		);
		expect(html).toContain("Fable");
		expect(html).toContain("Sonnet");
		expect(html).toContain("Opus");
		expect(html).toContain("acc-fable");
		expect(html).toContain("acc-b");
		expect(html).toContain("acc-a");
		expect(html).toContain("acc-c");
	});

	it("renders 1-based rank numbers for a multi-account chain", () => {
		const html = renderToStaticMarkup(
			<ObservedRoutingTable
				observations={{
					sonnet: mkObservation(
						"sonnet",
						["acc-a", "acc-b", "acc-c"],
						NOW - 1000,
					),
				}}
				now={NOW}
			/>,
		);
		expect(html).toContain('title="Position 1 of sonnet routing order"');
		expect(html).toContain('title="Position 2 of sonnet routing order"');
		expect(html).toContain('title="Position 3 of sonnet routing order"');
	});

	it("renders the observed-age text per family", () => {
		const html = renderToStaticMarkup(
			<ObservedRoutingTable
				observations={{
					fable: mkObservation("fable", ["acc-a"], NOW - 5000),
				}}
				now={NOW}
			/>,
		);
		expect(html).toContain("observed 5s ago");
	});
});
