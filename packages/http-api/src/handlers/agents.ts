import { agentRegistry } from "@better-ccflare/agents";
import {
	getAllowedModelsMessage,
	isValidClaudeModel,
	validateString,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	HttpError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("AgentsHandler");

export function createAgentsListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const agents = await agentRegistry.getAgents();
			const preferences = dbOps.getAllAgentPreferences();

			// Create a map of preferences for easy lookup
			const prefMap = new Map(preferences.map((p) => [p.agent_id, p.model]));

			// Merge preferences with agents
			const agentsWithPreferences = agents.map((agent) => ({
				...agent,
				model: prefMap.get(agent.id) || agent.model,
			}));

			// Group agents by source
			const globalAgents = agentsWithPreferences.filter(
				(a) => a.source === "global",
			);
			const workspaceAgents = agentsWithPreferences.filter(
				(a) => a.source === "workspace",
			);

			// Get workspaces
			const workspaces = agentRegistry.getWorkspaces();

			return jsonResponse({
				agents: agentsWithPreferences,
				globalAgents,
				workspaceAgents,
				workspaces,
			});
		} catch (error) {
			log.error("Error fetching agents:", error);
			return jsonResponse({ error: "Failed to fetch agents" }, 500);
		}
	};
}

export function createAgentPreferenceUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, agentId: string): Promise<Response> => {
		try {
			const body = await req.json();
			const { model } = body;

			if (!model) {
				throw BadRequest("Model is required");
			}

			// Validate model is in allowed list
			if (!isValidClaudeModel(model)) {
				throw BadRequest(`Invalid model. ${getAllowedModelsMessage()}`);
			}

			// Update preference
			dbOps.setAgentPreference(agentId, model);

			return jsonResponse({
				success: true,
				agentId,
				model,
			});
		} catch (error) {
			log.error("Error updating agent preference:", error);
			if (error instanceof HttpError) {
				return jsonResponse({ error: error.message }, error.status);
			}
			return jsonResponse({ error: "Failed to update agent preference" }, 500);
		}
	};
}

export function createWorkspacesListHandler() {
	return async (): Promise<Response> => {
		try {
			const workspaces = agentRegistry.getWorkspaces();

			// Add agent count for each workspace
			const agents = await agentRegistry.getAgents();
			const workspacesWithStats = workspaces.map((workspace) => {
				const agentCount = agents.filter(
					(a) => a.source === "workspace" && a.workspace === workspace.path,
				).length;

				return {
					...workspace,
					agentCount,
				};
			});

			return jsonResponse({ workspaces: workspacesWithStats });
		} catch (error) {
			log.error("Error fetching workspaces:", error);
			return jsonResponse({ error: "Failed to fetch workspaces" }, 500);
		}
	};
}

export function createBulkAgentPreferenceUpdateHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request): Promise<Response> => {
		const log = new Logger("BulkAgentPreferenceUpdate");

		try {
			const body = await req.json();

			// Validate input
			const modelValidation = validateString(body.model, "model", {
				required: true,
			});

			if (!modelValidation) {
				return errorResponse(BadRequest("Model is required"));
			}

			// Validate model is in allowed list
			if (!isValidClaudeModel(modelValidation)) {
				return errorResponse(
					BadRequest(`Invalid model. ${getAllowedModelsMessage()}`),
				);
			}

			// Get all agents from the registry
			const agents = await agentRegistry.getAgents();
			const agentIds = agents.map((agent) => agent.id);

			if (agentIds.length === 0) {
				return jsonResponse({ message: "No agents found to update" });
			}

			// Update all agent preferences in bulk
			dbOps.setBulkAgentPreferences(agentIds, modelValidation);

			log.info(
				`Updated ${agentIds.length} agent preferences to model: ${modelValidation}`,
			);

			return jsonResponse({
				success: true,
				updatedCount: agentIds.length,
				model: modelValidation,
			});
		} catch (error) {
			log.error("Error updating agent preferences in bulk:", error);

			if (error instanceof Error) {
				return errorResponse(BadRequest(error.message));
			}

			return jsonResponse({ error: "Failed to update agent preferences" }, 500);
		}
	};
}
