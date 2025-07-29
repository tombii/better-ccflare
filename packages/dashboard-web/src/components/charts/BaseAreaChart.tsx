import type { ReactNode } from "react";
import {
	Area,
	AreaChart,
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

interface BaseAreaChartProps {
	data: ChartDataPoint[];
	dataKey: string;
	xAxisKey?: string;
	loading?: boolean;
	height?: keyof typeof CHART_HEIGHTS | number;
	color?: string;
	gradientId?: string;
	customGradient?: ReactNode;
	strokeWidth?: number;
	fillOpacity?: number;
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
	margin?: { top?: number; right?: number; bottom?: number; left?: number };
	className?: string;
	error?: Error | null;
	emptyState?: ReactNode;
	onChartClick?: ChartClickHandler;
}

export function BaseAreaChart({
	data,
	dataKey,
	xAxisKey = "time",
	loading = false,
	height = "medium",
	color = COLORS.primary,
	gradientId = "colorGradient",
	customGradient,
	strokeWidth = 2,
	fillOpacity = 1,
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
	margin,
	className = "",
	error = null,
	emptyState,
	onChartClick,
}: BaseAreaChartProps) {
	const chartHeight =
		typeof height === "number" ? height : CHART_HEIGHTS[height];
	const isEmpty = !data || data.length === 0;

	const defaultGradient = (
		<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
			<stop offset="5%" stopColor={color} stopOpacity={0.8} />
			<stop offset="95%" stopColor={color} stopOpacity={0.1} />
		</linearGradient>
	);

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
				<AreaChart data={data} margin={margin} onClick={onChartClick}>
					<defs>{customGradient || defaultGradient}</defs>
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
					<Area
						type="monotone"
						dataKey={dataKey}
						stroke={color}
						strokeWidth={strokeWidth}
						fillOpacity={fillOpacity}
						fill={`url(#${gradientId})`}
						animationDuration={animationDuration}
					/>
				</AreaChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
