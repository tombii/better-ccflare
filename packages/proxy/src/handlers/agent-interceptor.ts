import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentRegistry } from "@better-ccflare/agents";
import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import { validatePath } from "@better-ccflare/security";
import type { AgentAttributionSource } from "@better-ccflare/types";
import { getModelCatalog, type ModelCatalog } from "../model-catalog";
import { RequestBodyContext } from "../request-body-context";

const log = new Logger("AgentInterceptor");

export interface AgentInterceptResult {
	modifiedBody: ArrayBuffer | null;
	agentUsed: string | null;
	originalModel: string | null;
	appliedModel: string | null;
	agentAttributionSource: AgentAttributionSource;
}

/**
 * Guards a preference-driven model rewrite against the live Anthropic model
 * catalog. Fail-open by design: a veto only ever comes from a confirmed
 * live catalog that doesn't list the target model. A stale/bundled fallback
 * catalog (whether because no live fetch has ever succeeded, or the catalog
 * came back empty) must never block a rewrite — the static fallback list is
 * not authoritative enough to justify overriding an explicit preference.
 */
export function isRewriteTargetServable(
	catalog: ModelCatalog | null | undefined,
	model: string,
): boolean {
	if (!catalog) return true;
	if (catalog.source !== "live") return true;
	if (catalog.models.length === 0) return true;
	return catalog.models.some((entry) => entry.id === model);
}

/**
 * Detects agent usage and modifies the request body to use the preferred model
 * @param requestBodyBuffer - The buffered request body
 * @param dbOps - Database operations instance
 * @param requestHeaders - Incoming request headers (used for x-anthropic-agent-id)
 * @param options.frontmatterModelFallback - When true, fall back to the
 *   agent's frontmatter `model` if no explicit DB preference is configured.
 *   Defaults to false (see `Config.getAgentFrontmatterModelFallback`).
 * @param options.getModelCatalog - Injectable model-catalog accessor (defaults
 *   to the real `getModelCatalog`), consulted before applying a preference
 *   rewrite via `isRewriteTargetServable`. Tests inject a stub to avoid the
 *   real disk-cache/network-backed implementation.
 * @returns Modified request body and agent detection information
 */
export async function interceptAndModifyRequest(
	requestBody: ArrayBuffer | RequestBodyContext | null,
	dbOps: DatabaseOperations,
	requestHeaders?: Headers,
	options?: {
		frontmatterModelFallback?: boolean;
		getModelCatalog?: () => Promise<ModelCatalog>;
	},
): Promise<AgentInterceptResult> {
	const loadModelCatalog = options?.getModelCatalog ?? getModelCatalog;
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
			agentAttributionSource: "none",
		};
	}

	// Extracted outside the try so a parse failure below still lets us report
	// the original model (best-effort) instead of resetting it to null.
	let originalModel: string | null = null;

	try {
		const parsedBody = bodyContext.getParsedJson();
		if (!parsedBody) {
			throw new Error("Request body is not valid JSON object");
		}

		// Extract original model
		originalModel =
			typeof parsedBody.model === "string" ? parsedBody.model : null;

		// Explicit agent attribution via header (vendor-neutral): lets any client —
		// a multi-agent orchestrator, a router, an SDK wrapper — declare which agent
		// issued the request, so downstream observability tools can attribute usage
		// per agent. Takes precedence over system-prompt matching; absent = unchanged.
		// The namespaced `x-better-ccflare-agent-id` header is preferred; the legacy
		// `x-anthropic-agent-id` header is honored for backward compatibility when
		// the namespaced header is absent.
		const explicitAgentId =
			requestHeaders?.get("x-better-ccflare-agent-id")?.trim()?.slice(0, 256) ||
			requestHeaders?.get("x-anthropic-agent-id")?.trim()?.slice(0, 256);
		if (explicitAgentId) {
			log.debug(`Agent attributed via explicit header: ${explicitAgentId}`);
			// Both the header path and the system-prompt path below rewrite the
			// model only on an explicit DB preference set via the dashboard/CLI;
			// an agent's frontmatter `model` is never consulted here, since a
			// declared agent id has no associated frontmatter to fall back to.
			const preference = await dbOps.getAgentPreference(explicitAgentId);
			const preferredModel = preference?.model;
			if (preferredModel && preferredModel !== originalModel) {
				const catalog = await loadModelCatalog();
				if (isRewriteTargetServable(catalog, preferredModel)) {
					log.info(
						`Modifying model from ${originalModel} to ${preferredModel}`,
					);
					bodyContext.setModel(preferredModel);
					return {
						modifiedBody: bodyContext.getBuffer(),
						agentUsed: explicitAgentId,
						originalModel,
						appliedModel: preferredModel,
						agentAttributionSource: "header_agent",
					};
				}
				log.warn(
					`Agent ${explicitAgentId} prefers model ${preferredModel} which is not in the live model list — passing through ${originalModel}`,
				);
			}
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: explicitAgentId,
				originalModel,
				appliedModel: originalModel,
				agentAttributionSource: "header_agent",
			};
		}

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
				agentAttributionSource: "none",
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

		// Detect agent usage — delegate to the registry's own matcher so the
		// containment/empty-prompt semantics live in exactly one place.
		const detectedAgent = await agentRegistry.findAgentByPrompt(systemPrompt);

		if (!detectedAgent) {
			// No agent detected
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: null,
				originalModel,
				appliedModel: originalModel,
				agentAttributionSource: "none",
			};
		}

		log.info(
			`Detected agent usage: ${detectedAgent.name} (${detectedAgent.id})`,
		);

		// Look up model preference. An explicit DB preference (set via the
		// dashboard/CLI) always wins. Absent that, the agent's frontmatter
		// `model` is only consulted as a fallback when explicitly opted in via
		// config — Claude Code already resolves frontmatter model aliases
		// client-side, so the registry's copy can go stale relative to what the
		// client actually resolved and sent; rewriting from it by default has
		// broken subagent spawns against dead alias targets in the past. A null
		// agent.model means "inherit" (no preference) either way.
		const preference = await dbOps.getAgentPreference(detectedAgent.id);
		const preferredModel =
			preference?.model ??
			(options?.frontmatterModelFallback ? detectedAgent.model : null);

		// If there's no preference at all, or it matches the original, no
		// modification is needed. agentUsed is still reported for attribution.
		if (!preferredModel || preferredModel === originalModel) {
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: detectedAgent.id,
				originalModel,
				appliedModel: originalModel,
				agentAttributionSource: "prompt_agent",
			};
		}

		const catalog = await loadModelCatalog();
		if (!isRewriteTargetServable(catalog, preferredModel)) {
			log.warn(
				`Agent ${detectedAgent.id} prefers model ${preferredModel} which is not in the live model list — passing through ${originalModel}`,
			);
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: detectedAgent.id,
				originalModel,
				appliedModel: originalModel,
				agentAttributionSource: "prompt_agent",
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
			agentAttributionSource: "prompt_agent",
		};
	} catch (error) {
		log.error("Failed to intercept/modify request:", error);
		// On error, return original body unmodified. originalModel may have
		// been extracted before the failure (best-effort) — preserve it
		// instead of resetting to null so downstream routing still sees it.
		return {
			modifiedBody: requestBodyBuffer,
			agentUsed: null,
			originalModel,
			appliedModel: originalModel,
			agentAttributionSource: "none",
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
