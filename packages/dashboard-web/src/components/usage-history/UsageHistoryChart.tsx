import type { UsageHistoryWindowSeries } from "@better-ccflare/types";
import { COLORS } from "../../constants";
import { BaseLineChart } from "../charts/BaseLineChart";
import { buildUsageChartData } from "./chart-data";

const WINDOW_COLORS: Record<string, string> = {
	five_hour: COLORS.primary,
	seven_day: COLORS.blue,
	seven_day_opus: COLORS.purple,
	seven_day_sonnet: COLORS.cyan,
};

interface Props {
	windows: UsageHistoryWindowSeries[];
	rangeMs: number;
	loading?: boolean;
	height?: number;
	emptyState?: string;
}

export function UsageHistoryChart({
	windows,
	rangeMs,
	loading,
	height = 400,
	emptyState = "Collecting usage data…",
}: Props) {
	const now = Date.now();
	const { rows, windowKeys, predictionKeys, markers } = buildUsageChartData(
		windows,
		now,
		rangeMs,
	);

	const lines = [
		...windowKeys.map((key) => ({
			dataKey: key,
			stroke: WINDOW_COLORS[key] ?? COLORS.indigo,
			name: key,
			connectNulls: true, // bridge the gaps left by per-window sampling
		})),
		// dashed forecast line per rising window, same colour as its actual line
		...predictionKeys.map((key) => {
			const base = key.replace("__pred", "");
			return {
				dataKey: key,
				stroke: WINDOW_COLORS[base] ?? COLORS.indigo,
				name: `${base} (forecast)`,
				strokeDasharray: "6 4",
				strokeWidth: 1,
				connectNulls: true,
			};
		}),
	];

	const referenceLines = markers.map((m) => ({
		x: m.x,
		stroke: COLORS.warning,
		label: m.label,
	}));

	// Numeric time axis with a domain extended to cover future reset markers and
	// forecast endpoints — otherwise recharts (category axis / data-bounded domain)
	// drops them entirely (Fable H1). Y headroom keeps overage (>100%) visible (L6).
	// Compute the x-domain and y-max with explicit loops rather than spreading
	// the point arrays into Math.min/Math.max — on the 7d/30d ranges a long-lived
	// instance accumulates tens of thousands of rows, and spreading that many
	// arguments throws `RangeError: Maximum call stack size exceeded`.
	let xMin = Number.POSITIVE_INFINITY;
	let xMax = Number.NEGATIVE_INFINITY;
	for (const r of rows) {
		if (r.t < xMin) xMin = r.t;
		if (r.t > xMax) xMax = r.t;
	}
	for (const m of markers) {
		if (m.x < xMin) xMin = m.x;
		if (m.x > xMax) xMax = m.x;
	}
	// Cap the right edge at the selected range's forward horizon so a far-future
	// forecast endpoint (clipped by allowDataOverflow) can't stretch a short
	// selection out to days. Markers are already bounded by the same horizon in
	// buildUsageChartData. Never let the cap fall below xMin (guards the empty /
	// single-point case where xMin would otherwise exceed the capped xMax).
	const cap = now + rangeMs;
	if (xMax > cap) xMax = cap;
	if (xMax < xMin) xMax = xMin;
	const hasX = Number.isFinite(xMin) && Number.isFinite(xMax);
	const xDomain: [number, number] = hasX ? [xMin, xMax] : [0, 1];

	let yMax = 100;
	const yKeys = [...windowKeys, ...predictionKeys];
	for (const r of rows) {
		for (const k of yKeys) {
			const v = r[k];
			if (typeof v === "number" && v > yMax) yMax = v;
		}
	}

	return (
		<BaseLineChart
			data={rows}
			xAxisKey="t"
			xAxisType="number"
			xAxisDomain={xDomain}
			lines={lines}
			referenceLines={referenceLines}
			loading={loading}
			height={height}
			showLegend
			yAxisDomain={[0, yMax]}
			emptyState={emptyState}
			xAxisTickFormatter={(v) => new Date(Number(v)).toLocaleString()}
			tooltipLabelFormatter={(v) => new Date(Number(v)).toLocaleString()}
			tooltipFormatter={(value, name) => [`${value}%`, String(name)]}
		/>
	);
}
