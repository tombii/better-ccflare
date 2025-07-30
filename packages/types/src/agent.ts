export interface Agent {
	id: string;
	name: string;
	description: string;
	color: string;
	model: string;
	systemPrompt: string;
}

export type AgentResponse = Agent[];

export const ALLOWED_MODELS = [
	"claude-opus-4-20250514",
	"claude-sonnet-4-20250514",
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];
