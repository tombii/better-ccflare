export { AgentRegistry } from "./discovery";
export { getAgentsDirectory } from "./paths";

// Create a singleton instance for convenience
import { AgentRegistry } from "./discovery";
export const agentRegistry = new AgentRegistry();
