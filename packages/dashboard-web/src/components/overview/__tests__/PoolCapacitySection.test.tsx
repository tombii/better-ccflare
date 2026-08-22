import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoutingObservation } from "../../../api";
import type { PoolUsageResult } from "../../../lib/pool-usage";
import { PoolCapacitySection } from "../PoolCapacitySection";

const NOW = 1_700_000_000_000;

// Deliberately empty so buildPoolSegments([]) inside PoolUsageRow yields no
// segments -- keeps the row itself uninteresting so these tests can focus on
// the observed-routing table below it.
const EMPTY_RESULT: PoolUsageResult = {
	average: null,
	activeAverage: null,
	worst: null,
	contributing: [],
	exhausted: [],
	excluded: [],
	fallback: [],
	earliestResetMs: null,
	earliestResetAccountName: null,
	atRisk: [],
};

function NoopIcon() {
	return null;
}

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

describe("PoolCapacitySection -- observed routing table", () => {
	const fablePool = {
		id: "scoped:Fable",
		title: "Fable pool",
		icon: NoopIcon,
		result: EMPTY_RESULT,
		window: "weekly_scoped" as const,
	};

	it("renders nothing extra when there are no observations at all", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				pools={[fablePool]}
				now={NOW}
				observations={undefined}
			/>,
		);
		expect(html).not.toContain("Observed routing order");
	});

	it("renders every observed family, including one that also has its own pool row", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				pools={[fablePool]}
				now={NOW}
				observations={{
					fable: mkObservation("fable", ["acc-fable"], NOW - 1000),
					sonnet: mkObservation("sonnet", ["acc-b", "acc-a"], NOW - 65_000),
					opus: mkObservation("opus", ["acc-c"], NOW - 5000),
				}}
			/>,
		);
		expect(html).toContain(
			"Observed routing order — the last decision the proxy actually made",
		);
		// fable has its own "Fable pool" row above AND still appears in the
		// observed-routing table -- the table is the single source, showing
		// every recorded family regardless of a pairing pool row.
		expect(html).toContain("acc-fable");
		expect(html).toContain("acc-c");
		expect(html).toContain("acc-b");
		expect(html).toContain("acc-a");
		expect(html).toContain("observed 5s ago");
		expect(html).toContain("observed 1m ago");
	});

	it("renders nothing at all (including the pool-capacity card) when pools is empty, even with observations", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				pools={[]}
				now={NOW}
				observations={{ opus: mkObservation("opus", ["acc-c"], NOW - 5000) }}
			/>,
		);
		expect(html).toBe("");
	});
});
