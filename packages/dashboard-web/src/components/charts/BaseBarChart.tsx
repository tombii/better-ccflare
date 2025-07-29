import type { ReactNode } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
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

interface BarConfig {
	dataKey: string;
	fill?: string;
	name?: string;
	yAxisId?: string;
	radius?: [number, number, number, number];
}

interface BaseBarChartProps {
	data: ChartDataPoint[];
	bars: BarConfig | BarConfig[];
	xAxisKey?: string;
	loading?: boolean;
	height?: keyof typeof CHART_HEIGHTS | number;
	layout?: "horizontal" | "vertical";
	xAxisAngle?: number;
	xAxisTextAnchor?: "start" | "middle" | "end";
	xAxisHeight?: number;
	xAxisType?: "number" | "category";
	yAxisType?: "number" | "category";
	yAxisWidth?: number;
	yAxisDomain?: [number | "auto", number | "auto"];
	yAxisOrientation?: "left" | "right";
	secondaryYAxis?: boolean;
	tooltipFormatter?: TooltipFormatterFunction;
	tooltipLabelFormatter?: (label: string) => string;
	tooltipStyle?: keyof typeof CHART_TOOLTIP_STYLE | object;
	animationDuration?: number;
	showLegend?: boolean;
	legendHeight?: number;
	margin?: { top?: number; right?: number; bottom?: number; left?: number };
	className?: string;
	error?: Error | null;
	emptyState?: ReactNode;
	onChartClick?: ChartClickHandler;
}

export function BaseBarChart({
	data,
	bars,
	xAxisKey = "name",
	loading = false,
	height = "medium",
	layout = "horizontal",
	xAxisAngle = 0,
	xAxisTextAnchor = "middle",
	xAxisHeight = 30,
	xAxisType = layout === "vertical" ? "number" : "category",
	yAxisType = layout === "vertical" ? "category" : "number",
	yAxisWidth,
	yAxisDomain,
	yAxisOrientation = "left",
	secondaryYAxis = false,
	tooltipFormatter,
	tooltipLabelFormatter,
	tooltipStyle = "default",
	animationDuration = 1000,
	showLegend = false,
	legendHeight = 36,
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
}: BaseBarChartProps) {
	const chartHeight =
		typeof height === "number" ? height : CHART_HEIGHTS[height];
	const isEmpty = !data || data.length === 0;
	const barConfigs = Array.isArray(bars) ? bars : [bars];

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
				<BarChart
					data={data}
					layout={layout}
					margin={margin}
					onClick={onChartClick}
				>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						className={CHART_PROPS.gridClassName}
					/>
					{layout === "vertical" ? (
						<>
							<XAxis type={xAxisType as "number"} className="text-xs" />
							<YAxis
								dataKey={xAxisKey}
								type={yAxisType as "category"}
								className="text-xs"
								width={yAxisWidth}
							/>
						</>
					) : (
						<>
							<XAxis
								dataKey={xAxisKey}
								type={xAxisType as "category"}
								className="text-xs"
								angle={xAxisAngle}
								textAnchor={xAxisTextAnchor}
								height={xAxisHeight}
							/>
							<YAxis
								yAxisId={secondaryYAxis ? "left" : undefined}
								type={yAxisType as "number"}
								className="text-xs"
								domain={yAxisDomain}
								orientation={yAxisOrientation}
							/>
							{secondaryYAxis && (
								<YAxis
									yAxisId="right"
									orientation="right"
									className="text-xs"
								/>
							)}
						</>
					)}
					<Tooltip
						contentStyle={tooltipStyles}
						formatter={tooltipFormatter}
						labelFormatter={tooltipLabelFormatter}
					/>
					{showLegend && <Legend height={legendHeight} />}
					{barConfigs.map((barConfig) => (
						<Bar
							key={barConfig.dataKey}
							dataKey={barConfig.dataKey}
							fill={barConfig.fill || COLORS.primary}
							name={barConfig.name || barConfig.dataKey}
							yAxisId={barConfig.yAxisId}
							radius={barConfig.radius}
							animationDuration={animationDuration}
						/>
					))}
				</BarChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
