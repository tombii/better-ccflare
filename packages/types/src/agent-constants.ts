import type { AgentTool } from "./agent";

export const ALL_TOOLS: AgentTool[] = [
	"Bash",
	"Glob",
	"Grep",
	"LS",
	"Read",
	"Edit",
	"MultiEdit",
	"Write",
	"NotebookRead",
	"NotebookEdit",
	"WebFetch",
	"TodoWrite",
	"WebSearch",
];

export const TOOL_PRESETS = {
	all: [] as AgentTool[], // empty means don't set tools property
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
