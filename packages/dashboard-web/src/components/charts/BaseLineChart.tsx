import type { ReactElement } from "react";
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
import { CHART_PROPS, COLORS } from "../../constants";
import { ChartContainer } from "./ChartContainer";
import {
	type CommonChartProps,
	getChartHeight,
	getTooltipStyles,
	isChartEmpty,
} from "./chart-utils";

interface LineConfig {
	dataKey: string;
	stroke?: string;
	strokeWidth?: number;
	dot?: boolean;
	name?: string;
	strokeDasharray?: string;
	connectNulls?: boolean;
}

interface ReferenceLineConfig {
	x?: number | string;
	y?: number;
	stroke?: string;
	strokeDasharray?: string;
	label?: string;
}

interface BaseLineChartProps extends CommonChartProps {
	lines: LineConfig | LineConfig[];
	referenceLines?: ReferenceLineConfig[];
	xAxisType?: "number" | "category";
	xAxisDomain?: [number | string, number | string];
	// Fully custom recharts tooltip. recharts clones this element with the
	// injected `active`/`payload`/`label` props. When set, it replaces the
	// default formatter-based tooltip (other charts are unaffected).
	tooltipContent?: ReactElement;
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
	xAxisTickFormatter,
	xAxisType,
	xAxisDomain,
	yAxisDomain,
	yAxisTickFormatter,
	tooltipFormatter,
	tooltipLabelFormatter,
	tooltipContent,
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
	const chartHeight = getChartHeight(height);
	const isEmpty = isChartEmpty(data);
	const tooltipStyles = getTooltipStyles(tooltipStyle);
	const lineConfigs = Array.isArray(lines) ? lines : [lines];

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
						type={xAxisType}
						domain={xAxisDomain}
						allowDataOverflow
						className="text-xs"
						angle={xAxisAngle}
						textAnchor={xAxisTextAnchor}
						height={xAxisHeight}
						tickFormatter={xAxisTickFormatter}
					/>
					<YAxis
						className="text-xs"
						domain={yAxisDomain}
						tickFormatter={yAxisTickFormatter}
					/>
					{tooltipContent ? (
						<Tooltip content={tooltipContent} />
					) : (
						<Tooltip
							contentStyle={tooltipStyles}
							// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
							formatter={tooltipFormatter as any}
							// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened labelFormatter label to ReactNode
							labelFormatter={tooltipLabelFormatter as any}
						/>
					)}
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
							strokeDasharray={lineConfig.strokeDasharray}
							connectNulls={lineConfig.connectNulls ?? false}
						/>
					))}
					{referenceLines.map((refLine, refIndex) => (
						<ReferenceLine
							// biome-ignore lint/suspicious/noArrayIndexKey: referenceLines is a static config array (no reorder); y may be undefined for x-only markers so it cannot key
							key={`ref-line-${refIndex}`}
							x={refLine.x}
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
