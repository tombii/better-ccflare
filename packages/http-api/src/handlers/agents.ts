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
import type { APIContext } from "@better-ccflare/types";

const log = new Logger("AgentsHandler");

/**
 * Non-blocking parity check against the live model catalog (mirrors the
 * proxy's `isRewriteTargetServable` veto, but never blocks the write — the
 * preference is already persisted by the time this runs). Only warns when
 * the catalog is confirmed live and non-empty and doesn't list the model;
 * a fallback/offline/errored catalog never produces a warning, matching the
 * fail-open semantics of the proxy-side guard.
 */
async function getLiveCatalogWarning(
	modelCatalog: APIContext["modelCatalog"] | undefined,
	model: string,
): Promise<string | undefined> {
	if (!modelCatalog) return undefined;
	try {
		const catalog = await modelCatalog.get();
		if (catalog.source !== "live" || catalog.models.length === 0) {
			return undefined;
		}
		if (catalog.models.some((entry) => entry.id === model)) {
			return undefined;
		}
		return `Model '${model}' not present in the live Anthropic model list — it may fail upstream.`;
	} catch {
		return undefined;
	}
}

export function createAgentsListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const agents = await agentRegistry.getAgents();
			const preferences = await dbOps.getAllAgentPreferences();

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
			const pluginAgents = agentsWithPreferences.filter(
				(a) => a.source === "plugin",
			);

			// Get workspaces
			const workspaces = agentRegistry.getWorkspaces();

			return jsonResponse({
				agents: agentsWithPreferences,
				globalAgents,
				workspaceAgents,
				pluginAgents,
				workspaces,
			});
		} catch (error) {
			log.error("Error fetching agents:", error);
			return jsonResponse({ error: "Failed to fetch agents" }, 500);
		}
	};
}

export function createAgentPreferenceUpdateHandler(
	dbOps: DatabaseOperations,
	modelCatalog?: APIContext["modelCatalog"],
) {
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

			const warning = await getLiveCatalogWarning(modelCatalog, model);

			return jsonResponse({
				success: true,
				agentId,
				model,
				...(warning ? { warning } : {}),
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

/**
 * Removes an agent's explicit model preference so it falls back to its
 * frontmatter model — or, for `inherit`/no-model agents, to the session's
 * model. This is the only way to revert to "no override" from the
 * dashboard: the POST handler above requires a concrete model value.
 */
export function createAgentPreferenceDeleteHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, agentId: string): Promise<Response> => {
		try {
			const deleted = await dbOps.deleteAgentPreference(agentId);
			return jsonResponse({ success: true, agentId, deleted });
		} catch (error) {
			log.error("Error deleting agent preference:", error);
			return jsonResponse({ error: "Failed to delete agent preference" }, 500);
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
	modelCatalog?: APIContext["modelCatalog"],
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

			const warning = await getLiveCatalogWarning(
				modelCatalog,
				modelValidation,
			);

			return jsonResponse({
				success: true,
				updatedCount: agentIds.length,
				model: modelValidation,
				...(warning ? { warning } : {}),
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
