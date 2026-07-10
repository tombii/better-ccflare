import { agentRegistry } from "@better-ccflare/agents";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	Forbidden,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import type {
	AgentTool,
	AllowedModel,
	APIContext,
} from "@better-ccflare/types";
import { TOOL_PRESETS } from "@better-ccflare/types";
import {
	allowedModelErrorMessage,
	isAllowedModel,
} from "../services/model-validation";

type ToolMode = keyof typeof TOOL_PRESETS | "custom";

interface AgentUpdateRequest {
	description?: string;
	/** `null` (or the string "inherit", case-insensitive) reverts to inheriting the session model. */
	model?: AllowedModel | null;
	tools?: AgentTool[];
	color?: string;
	systemPrompt?: string;
	mode?: ToolMode;
}

export function createAgentUpdateHandler(
	dbOps: DatabaseOperations,
	modelCatalog?: APIContext["modelCatalog"],
) {
	return async (req: Request, agentId: string): Promise<Response> => {
		try {
			const body = (await req.json()) as AgentUpdateRequest;

			// Validate individual pieces
			const updates: Partial<{
				description: string;
				model: AllowedModel | null;
				tools: AgentTool[];
				color: string;
				systemPrompt: string;
			}> = {};

			if (body.description !== undefined) {
				if (typeof body.description !== "string") {
					return errorResponse(BadRequest("Description must be a string"));
				}
				updates.description = body.description;
			}

			if (body.model !== undefined) {
				if (
					body.model === null ||
					body.model.trim().toLowerCase() === "inherit"
				) {
					updates.model = null;
				} else if (!(await isAllowedModel(body.model, modelCatalog))) {
					return errorResponse(
						BadRequest(`Invalid model. ${allowedModelErrorMessage()}`),
					);
				} else {
					updates.model = body.model;
				}
			}

			if (body.color !== undefined) {
				if (typeof body.color !== "string") {
					return errorResponse(BadRequest("Color must be a string"));
				}
				updates.color = body.color;
			}

			if (body.systemPrompt !== undefined) {
				if (typeof body.systemPrompt !== "string") {
					return errorResponse(BadRequest("System prompt must be a string"));
				}
				updates.systemPrompt = body.systemPrompt;
			}

			// Handle tools - either from mode or explicit tools array
			if (body.mode !== undefined) {
				if (body.mode === "custom") {
					if (!body.tools || !Array.isArray(body.tools)) {
						return errorResponse(
							BadRequest("Tools array is required when mode is 'custom'"),
						);
					}
					updates.tools = body.tools;
				} else if (body.mode in TOOL_PRESETS) {
					updates.tools = TOOL_PRESETS[body.mode];
				} else {
					return errorResponse(
						BadRequest(
							`Invalid mode. Must be one of: ${Object.keys(TOOL_PRESETS).join(", ")}, custom`,
						),
					);
				}
			} else if (body.tools !== undefined) {
				if (!Array.isArray(body.tools)) {
					return errorResponse(BadRequest("Tools must be an array"));
				}
				updates.tools = body.tools;
			}

			// Update agent using the registry
			const updated = await agentRegistry.updateAgent(agentId, updates, {
				deleteAgentPreference: (id: string) => dbOps.deleteAgentPreference(id),
			});

			return jsonResponse({ success: true, agent: updated });
		} catch (error) {
			if (error instanceof Error && error.message.includes("not found")) {
				return errorResponse(NotFound(`Agent with id ${agentId} not found`));
			}
			if (error instanceof Error && error.message.includes("plugin-managed")) {
				return errorResponse(Forbidden(error.message));
			}
			console.error("Error updating agent:", error);
			return errorResponse(InternalServerError("Failed to update agent"));
		}
	};
}
