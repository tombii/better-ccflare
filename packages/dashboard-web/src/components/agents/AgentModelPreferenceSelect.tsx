import { getModelDisplayName } from "@better-ccflare/core";
import type { Agent } from "@better-ccflare/types";
import {
	AGENT_DEFAULT_MODEL_SENTINEL,
	useUpdateAgentPreference,
} from "../../hooks/queries";
import { ModelSelect } from "./ModelSelect";

interface AgentModelPreferenceSelectProps {
	agent: Agent;
	triggerClassName?: string;
}

/**
 * Shared model-preference control: the DB preference dropdown used by both
 * the agent card and the edit dialog. A single source of truth so the two
 * surfaces can never drift — same derivation, same mutation, same backend
 * (`POST`/`DELETE /api/agents/:id/preference`).
 */
export function AgentModelPreferenceSelect({
	agent,
	triggerClassName,
}: AgentModelPreferenceSelectProps) {
	const updatePreference = useUpdateAgentPreference();

	// Honest default state: only treat the select as an explicit choice when
	// the API confirms it came from a DB preference. Any other known
	// provenance (frontmatter/inherit) shows as the default sentinel instead
	// of a fake explicit selection; an older API (no modelSource) falls back
	// to the previous behavior.
	const modelSelectValue =
		agent.modelSource === "preference"
			? (agent.model ?? undefined)
			: agent.modelSource !== undefined
				? AGENT_DEFAULT_MODEL_SENTINEL
				: (agent.model ?? undefined);

	// The default sentinel item spells out what "revert to default" actually
	// resolves to, based on whether the agent has a frontmatter model.
	const modelDefaultItem =
		agent.modelSource === undefined
			? { label: "Agent default (frontmatter / inherit)" }
			: agent.frontmatterModel
				? {
						label: `Agent default — ${getModelDisplayName(agent.frontmatterModel)}`,
						badgeLabel: "Default",
					}
				: { label: "Agent default — session model", badgeLabel: "Inherited" };

	return (
		<ModelSelect
			value={modelSelectValue}
			onValueChange={(value) =>
				updatePreference.mutate({ agentId: agent.id, model: value })
			}
			disabled={updatePreference.isPending}
			placeholder="Inherit (session model)"
			triggerClassName={triggerClassName}
			defaultItem={modelDefaultItem}
		/>
	);
}
