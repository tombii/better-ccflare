import type { ReactNode } from "react";
import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import {
	CHART_HEIGHTS,
	CHART_PROPS,
	CHART_TOOLTIP_STYLE,
	COLORS,
} from "../../constants";
import { ChartContainer } from "./ChartContainer";
import type {
	ChartClickHandler,
	ChartDataPoint,
	TooltipFormatterFunction,
} from "./types";

interface LineConfig {
	dataKey: string;
	stroke?: string;
	strokeWidth?: number;
	dot?: boolean;
	name?: string;
}

interface ReferenceLineConfig {
	y: number;
	stroke?: string;
	strokeDasharray?: string;
	label?: string;
}

interface BaseLineChartProps {
	data: ChartDataPoint[];
	lines: LineConfig | LineConfig[];
	xAxisKey?: string;
	loading?: boolean;
	height?: keyof typeof CHART_HEIGHTS | number;
	xAxisAngle?: number;
	xAxisTextAnchor?: "start" | "middle" | "end";
	xAxisHeight?: number;
	yAxisDomain?: [number | "auto", number | "auto"];
	tooltipFormatter?: TooltipFormatterFunction;
	tooltipLabelFormatter?: (label: string) => string;
	tooltipStyle?: keyof typeof CHART_TOOLTIP_STYLE | object;
	animationDuration?: number;
	showLegend?: boolean;
	legendHeight?: number;
	referenceLines?: ReferenceLineConfig[];
	margin?: { top?: number; right?: number; bottom?: number; left?: number };
	className?: string;
	error?: Error | null;
	emptyState?: ReactNode;
	onChartClick?: ChartClickHandler;
}

export function BaseLineChart({
	data,
	lines,
	xAxisKey = "time",
	loading = false,
	height = "medium",
	xAxisAngle = 0,
	xAxisTextAnchor = "middle",
	xAxisHeight = 30,
	yAxisDomain,
	tooltipFormatter,
	tooltipLabelFormatter,
	tooltipStyle = "default",
	animationDuration = 1000,
	showLegend = false,
	legendHeight = 36,
	referenceLines = [],
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
}: BaseLineChartProps) {
	const chartHeight =
		typeof height === "number" ? height : CHART_HEIGHTS[height];
	const isEmpty = !data || data.length === 0;
	const lineConfigs = Array.isArray(lines) ? lines : [lines];

	const tooltipStyles =
		typeof tooltipStyle === "string"
			? CHART_TOOLTIP_STYLE[tooltipStyle]
			: tooltipStyle;

	return (
		<ChartContainer
			loading={loading}
			height={height}
			className={className}
			error={error}
			isEmpty={isEmpty}
			emptyState={emptyState}
		>
			<ResponsiveContainer width="100%" height={chartHeight}>
				<LineChart data={data} margin={margin} onClick={onChartClick}>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						className={CHART_PROPS.gridClassName}
					/>
					<XAxis
						dataKey={xAxisKey}
						className="text-xs"
						angle={xAxisAngle}
						textAnchor={xAxisTextAnchor}
						height={xAxisHeight}
					/>
					<YAxis className="text-xs" domain={yAxisDomain} />
					<Tooltip
						contentStyle={tooltipStyles}
						formatter={tooltipFormatter}
						labelFormatter={tooltipLabelFormatter}
					/>
					{showLegend && <Legend height={legendHeight} />}
					{lineConfigs.map((lineConfig, _index) => (
						<Line
							key={lineConfig.dataKey}
							type="monotone"
							dataKey={lineConfig.dataKey}
							stroke={lineConfig.stroke || COLORS.primary}
							strokeWidth={lineConfig.strokeWidth || 2}
							dot={lineConfig.dot ?? false}
							name={lineConfig.name || lineConfig.dataKey}
							animationDuration={animationDuration}
						/>
					))}
					{referenceLines.map((refLine, index) => (
						<ReferenceLine
							key={`ref-line-${index}`}
							y={refLine.y}
							stroke={refLine.stroke || COLORS.primary}
							strokeDasharray={
								refLine.strokeDasharray || CHART_PROPS.strokeDasharray
							}
							label={refLine.label}
						/>
					))}
				</LineChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
