import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentRegistry } from "@better-ccflare/agents";
import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import { validatePath } from "@better-ccflare/security";
import type { Agent } from "@better-ccflare/types";
import { RequestBodyContext } from "../request-body-context";

const log = new Logger("AgentInterceptor");

export interface AgentInterceptResult {
	modifiedBody: ArrayBuffer | null;
	agentUsed: string | null;
	originalModel: string | null;
	appliedModel: string | null;
}

/**
 * Detects agent usage and modifies the request body to use the preferred model
 * @param requestBodyBuffer - The buffered request body
 * @param dbOps - Database operations instance
 * @returns Modified request body and agent detection information
 */
export async function interceptAndModifyRequest(
	requestBody: ArrayBuffer | RequestBodyContext | null,
	dbOps: DatabaseOperations,
): Promise<AgentInterceptResult> {
	const bodyContext =
		requestBody instanceof RequestBodyContext
			? requestBody
			: new RequestBodyContext(requestBody);
	const requestBodyBuffer = bodyContext.getBuffer();

	// If no body, nothing to intercept
	if (!requestBodyBuffer) {
		return {
			modifiedBody: null,
			agentUsed: null,
			originalModel: null,
			appliedModel: null,
		};
	}

	try {
		const parsedBody = bodyContext.getParsedJson();
		if (!parsedBody) {
			throw new Error("Request body is not valid JSON object");
		}

		// Extract original model
		const originalModel =
			typeof parsedBody.model === "string" ? parsedBody.model : null;

		// Extract system prompt to detect agent usage
		const systemPrompt = extractSystemPrompt(parsedBody as RequestBody);
		if (!systemPrompt) {
			// No system prompt, no agent detection possible
			log.debug("No system prompt found in request");
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: null,
				originalModel,
				appliedModel: originalModel,
			};
		}

		// Register additional agent directories from system prompt
		log.debug(`System prompt length: ${systemPrompt.length} chars`);
		if (systemPrompt.includes("CLAUDE.md")) {
			log.debug("System prompt contains CLAUDE.md reference");

			// Look specifically for the Contents pattern
			if (systemPrompt.includes("Contents of")) {
				const contentsIndex = systemPrompt.indexOf("Contents of");
				const start = contentsIndex;
				const end = Math.min(systemPrompt.length, contentsIndex + 200);
				const sample = systemPrompt.substring(start, end);
				log.debug(`Found 'Contents of' pattern: ${sample}`);
			} else {
				log.debug("System prompt does NOT contain 'Contents of' pattern");
				// Show a sample of what we do have
				const claudeIndex = systemPrompt.indexOf("CLAUDE.md");
				const start = Math.max(0, claudeIndex - 50);
				const end = Math.min(systemPrompt.length, claudeIndex + 50);
				const sample = systemPrompt.substring(start, end);
				log.debug(`Sample around CLAUDE.md: ...${sample}...`);
			}

			// Count all CLAUDE.md occurrences
			const matches = systemPrompt.match(/CLAUDE\.md/g);
			log.debug(`Total CLAUDE.md occurrences: ${matches ? matches.length : 0}`);
		}

		const extraDirs = extractAgentDirectories(systemPrompt);
		log.debug(
			`Validated ${extraDirs.length} agent directories from system prompt`,
		);

		for (const dir of extraDirs) {
			log.debug(`Checking potential workspace from agents directory: ${dir}`);
			// Extract workspace path from agents directory
			// Convert /path/to/project/.claude/agents to /path/to/project
			const workspacePath = dir.replace(/\/.claude\/agents$/, "");

			// Only register if the workspace exists
			if (existsSync(workspacePath)) {
				await agentRegistry.registerWorkspace(workspacePath);
				log.info(`Registered workspace: ${workspacePath}`);
			} else {
				log.debug(`Workspace path does not exist: ${workspacePath}`);
			}
		}

		// Detect agent usage
		const agents = await agentRegistry.getAgents();
		const detectedAgent = agents.find((agent: Agent) =>
			systemPrompt.includes(agent.systemPrompt.trim()),
		);

		if (!detectedAgent) {
			// No agent detected
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: null,
				originalModel,
				appliedModel: originalModel,
			};
		}

		log.info(
			`Detected agent usage: ${detectedAgent.name} (${detectedAgent.id})`,
		);

		// Look up model preference
		const preference = await dbOps.getAgentPreference(detectedAgent.id);
		const preferredModel = preference?.model || detectedAgent.model;

		// If the preferred model is the same as original, no modification needed
		if (preferredModel === originalModel) {
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: detectedAgent.id,
				originalModel,
				appliedModel: originalModel,
			};
		}

		// Modify the request body with the preferred model
		log.info(`Modifying model from ${originalModel} to ${preferredModel}`);
		bodyContext.setModel(preferredModel);

		return {
			modifiedBody: bodyContext.getBuffer(),
			agentUsed: detectedAgent.id,
			originalModel,
			appliedModel: preferredModel,
		};
	} catch (error) {
		log.error("Failed to intercept/modify request:", error);
		// On error, return original body unmodified
		return {
			modifiedBody: requestBodyBuffer,
			agentUsed: null,
			originalModel: null,
			appliedModel: null,
		};
	}
}

interface MessageContent {
	type?: string;
	text?: string;
}

interface Message {
	role?: string;
	content?: string | MessageContent[];
}

interface SystemMessage {
	type: string;
	text: string;
	cache_control?: {
		type: string;
	};
}

interface RequestBody {
	messages?: Message[];
	model?: string;
	system?: string | SystemMessage[];
}

/**
 * Extracts system prompt from request body
 * This will extract system messages and user messages that contain system-like content
 * @param requestBody - Parsed request body
 * @returns System prompt string or null
 */
function extractSystemPrompt(requestBody: RequestBody): string | null {
	const extractLog = new Logger("ExtractSystemPrompt");
	const allSystemContent: string[] = [];

	// First check for system field at root level (Claude Code pattern)
	if (requestBody.system) {
		extractLog.debug("Found system field at root level");
		if (typeof requestBody.system === "string") {
			extractLog.debug(
				`System field is string, length: ${requestBody.system.length}`,
			);
			allSystemContent.push(requestBody.system);
		}
		if (Array.isArray(requestBody.system)) {
			extractLog.debug(
				`System field is array with ${requestBody.system.length} items`,
			);
			// Concatenate all text from system messages
			const systemText = requestBody.system
				.filter(
					(item): item is SystemMessage => item.type === "text" && !!item.text,
				)
				.map((item) => item.text)
				.join("\n");
			extractLog.debug(`Extracted system text length: ${systemText.length}`);
			if (systemText) {
				allSystemContent.push(systemText);
			}
		}
	}

	// Then check messages array
	if (requestBody.messages && Array.isArray(requestBody.messages)) {
		extractLog.debug(
			`Checking messages array with ${requestBody.messages.length} messages`,
		);

		// Look for system messages
		const systemMessage = requestBody.messages.find(
			(msg) => msg.role === "system",
		);

		if (systemMessage) {
			extractLog.debug("Found system role message");
			if (typeof systemMessage.content === "string") {
				extractLog.debug(
					`System message content is string, length: ${systemMessage.content.length}`,
				);
				allSystemContent.push(systemMessage.content);
			}
			if (Array.isArray(systemMessage.content)) {
				extractLog.debug(
					`System message content is array with ${systemMessage.content.length} items`,
				);
				const systemText = systemMessage.content
					.filter(
						(item): item is MessageContent & { text: string } =>
							item.type === "text" && !!item.text,
					)
					.map((item) => item.text)
					.join("\n");
				extractLog.debug(
					`Extracted system message text length: ${systemText.length}`,
				);
				if (systemText) {
					allSystemContent.push(systemText);
				}
			}
		} else {
			extractLog.debug("No system role message found, checking user messages");
		}

		// Also check for system prompt in user messages
		const userMessage = requestBody.messages.find((msg) => msg.role === "user");

		if (userMessage && Array.isArray(userMessage.content)) {
			// Concatenate all text content from the user message
			const textContents = userMessage.content.filter(
				(item): item is MessageContent & { text: string } =>
					item.type === "text" && !!item.text,
			);

			extractLog.debug(
				`Found ${textContents.length} text content items in user message`,
			);

			const allUserText = textContents.map((item) => item.text).join("\n");

			if (
				allUserText.includes("Contents of") &&
				allUserText.includes("CLAUDE.md")
			) {
				extractLog.debug(
					"User message contains 'Contents of' and 'CLAUDE.md' - including in system prompt",
				);
				allSystemContent.push(allUserText);
			}
		} else if (userMessage && typeof userMessage.content === "string") {
			if (
				userMessage.content.includes("Contents of") &&
				userMessage.content.includes("CLAUDE.md")
			) {
				extractLog.debug(
					"User message string contains 'Contents of' and 'CLAUDE.md' - including in system prompt",
				);
				allSystemContent.push(userMessage.content);
			}
		}
	}

	// Combine all system content
	if (allSystemContent.length > 0) {
		const combined = allSystemContent.join("\n\n");
		extractLog.debug(
			`Combined system prompt length: ${combined.length} from ${allSystemContent.length} sources`,
		);
		return combined;
	}

	return null;
}

/**
 * Extracts agent directories from system prompt
 *
 * **Performance Optimizations:**
 * - Reduced redundant log calls for successful validations
 * - Production-optimized logging (debug level for success cases)
 * - Leverages security package caching for repeated validations
 * - Early returns for invalid paths to avoid unnecessary processing
 *
 * **Performance Note:**
 * This function runs on every request and performs:
 * - Two regex pattern matches (optimized for typical prompt sizes)
 * - 7-layer security validation per path (cached via security package)
 * - Minimal structured logging for security monitoring
 *
 * For high-traffic production deployments, monitor cache hit rates via
 * security.getValidationCacheSize() to ensure effectiveness.
 *
 * @param systemPrompt - The system prompt text
 * @returns Array of agent directory paths
 */
function extractAgentDirectories(systemPrompt: string): string[] {
	const extractDirLog = new Logger("ExtractAgentDirs");
	const directories = new Set<string>();
	const isProduction = process.env.NODE_ENV === "production";

	// PERFORMANCE: Process both patterns with optimized logging
	const processPath = (
		rawPath: string,
		description: string,
		finalPath?: string,
		options?: { additionalAllowedPaths?: string[] },
	) => {
		const pathToValidate = finalPath || rawPath;

		// Validate path using comprehensive security checks (cached)
		const validationOptions = {
			description,
			...(options || {}),
		};
		const validation = validatePath(pathToValidate, validationOptions);
		if (!validation.isValid) {
			extractDirLog.warn(
				`Rejected invalid ${description}: ${pathToValidate} - ${validation.reason}`,
			);
			return;
		}

		// PERFORMANCE: Minimal logging in production
		if (isProduction) {
			extractDirLog.debug(
				`Validated ${description}: ${validation.resolvedPath}`,
			);
		} else {
			extractDirLog.info(
				`Validated ${description}: ${validation.resolvedPath}`,
			);
		}

		directories.add(validation.resolvedPath);
	};

	// Regex #1: Look for explicit /.claude/agents paths
	const agentPathRegex = /([\\/][\w\-. ]*?\/.claude\/agents)(?=[\s"'\]])/g;
	const agentPathMatches = systemPrompt.matchAll(agentPathRegex);
	for (const match of agentPathMatches) {
		processPath(match[1], "agent path", undefined, undefined);
	}

	// Regex #2: Look for repo root pattern "Contents of (.*?)/CLAUDE.md"
	const repoRootRegex = /Contents of ([^\n]+?)\/CLAUDE\.md/g;
	const repoRootMatches = systemPrompt.matchAll(repoRootRegex);
	const homeClaudeDir = join(homedir(), ".claude");
	for (const match of repoRootMatches) {
		const repoRoot = match[1];

		// Clean up any escaped slashes and construct agents directory first
		const cleanedRoot = repoRoot.replace(/\\\//g, "/");

		// ~/.claude/CLAUDE.md is the user's global Claude Code config, not a
		// project repo root. Global agents at ~/.claude/agents are loaded
		// unconditionally by AgentRegistry.loadAgents() via getAgentsDirectory(),
		// so constructing ~/.claude/.claude/agents here would only produce a
		// non-existent path and a noisy security-validation warning.
		if (cleanedRoot === homeClaudeDir) {
			continue;
		}

		const agentsDir = join(cleanedRoot, ".claude", "agents");

		// Validate the constructed agents directory directly
		// Allow the home .claude directory path for agent functionality (consciously decided to support Claude AI agents)
		// SECURITY NOTE: This is a deliberate decision to allow Claude Code to access agents in ~/.claude directory.
		// The path validation system was restricting access to ~/.claude/.claude/agents which is needed for proper agent functionality.
		// This addition maintains security by only allowing this specific path while keeping all other restrictions in place.
		const additionalAllowedPaths = [homeClaudeDir];
		processPath(
			agentsDir,
			"constructed agents directory from CLAUDE.md",
			undefined,
			{ additionalAllowedPaths },
		);
	}

	return Array.from(directories);
}
