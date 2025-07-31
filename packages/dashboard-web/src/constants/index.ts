// Re-export all shared constants from ui-constants
export {
	API_LIMITS,
	API_TIMEOUT,
	CHART_COLORS,
	CHART_HEIGHTS,
	CHART_PROPS,
	CHART_TOOLTIP_STYLE,
	COLORS,
	QUERY_CONFIG,
	REFRESH_INTERVALS,
	TIME_RANGES,
	type TimeRange,
} from "@ccflare/ui-constants";

import type { AgentTool } from "@ccflare/types";

export const TOOL_PRESETS = {
	all: [] as AgentTool[], // empty => don't write tools: key
	edit: ["Edit", "MultiEdit", "Write", "NotebookEdit"] as AgentTool[],
	"read-only": [
		"Glob",
		"Grep",
		"LS",
		"Read",
		"NotebookRead",
		"WebFetch",
		"TodoWrite",
		"WebSearch",
	] as AgentTool[],
	execution: ["Bash"] as AgentTool[],
} as const;
