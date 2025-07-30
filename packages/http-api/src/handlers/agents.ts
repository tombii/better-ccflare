import { agentRegistry } from "@ccflare/agents";
import type { DatabaseOperations } from "@ccflare/database";
import { BadRequest, HttpError, jsonResponse } from "@ccflare/http-common";
import { Logger } from "@ccflare/logger";
import { ALLOWED_MODELS } from "@ccflare/types";

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

			return jsonResponse({ agents: agentsWithPreferences });
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
			if (!ALLOWED_MODELS.includes(model)) {
				throw BadRequest(
					`Invalid model. Allowed models: ${ALLOWED_MODELS.join(", ")}`,
				);
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
