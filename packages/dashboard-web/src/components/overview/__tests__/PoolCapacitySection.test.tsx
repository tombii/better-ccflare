import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoutingObservation } from "../../../api";
import type { PoolUsageResult } from "../../../lib/pool-usage";
import { PoolCapacitySection } from "../PoolCapacitySection";

const NOW = 1_700_000_000_000;

// Deliberately empty so buildPoolSegments([]) inside PoolUsageRow yields no
// segments -- keeps the row itself uninteresting so these tests can focus on
// the "other model families" block below it.
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

describe("PoolCapacitySection -- other model families block", () => {
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
				poolFamilies={["Fable"]}
			/>,
		);
		expect(html).not.toContain("other model families");
	});

	it("renders nothing extra when every observation pairs with a pool family", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				pools={[fablePool]}
				now={NOW}
				observations={{ fable: mkObservation("fable", ["acc-a"], NOW - 5000) }}
				poolFamilies={["Fable"]}
			/>,
		);
		expect(html).not.toContain("other model families");
	});

	it("renders one line per unpaired family, sorted alphabetically, with age and order", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				pools={[fablePool]}
				now={NOW}
				observations={{
					fable: mkObservation("fable", ["acc-fable"], NOW - 1000),
					sonnet: mkObservation("sonnet", ["acc-b", "acc-a"], NOW - 65_000),
					opus: mkObservation("opus", ["acc-c"], NOW - 5000),
				}}
				poolFamilies={["Fable"]}
			/>,
		);
		expect(html).toContain("Observed routing — other model families");
		// fable pairs away with the "Fable" pool -- its own observation text
		// must not leak into the block (checked via the distinctive account
		// name that only fable's observation carries).
		expect(html).not.toContain("acc-fable");
		// opus (5s old) before sonnet (65s old) -- alphabetical, not by age.
		const opusIndex = html.indexOf(">opus<");
		const sonnetIndex = html.indexOf(">sonnet<");
		expect(opusIndex).toBeGreaterThan(-1);
		expect(sonnetIndex).toBeGreaterThan(-1);
		expect(opusIndex).toBeLessThan(sonnetIndex);
		expect(html).toContain("observed 5s ago");
		expect(html).toContain("observed 1m ago");
		expect(html).toContain("acc-c");
		expect(html).toContain("acc-b → acc-a");
	});

	it("renders nothing at all (including the pool-capacity card) when pools is empty, even with unpaired observations", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				pools={[]}
				now={NOW}
				observations={{ opus: mkObservation("opus", ["acc-c"], NOW - 5000) }}
				poolFamilies={[]}
			/>,
		);
		expect(html).toBe("");
	});
});
