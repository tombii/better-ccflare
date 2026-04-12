import { Logger } from "@better-ccflare/logger";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../openai/provider";

const _log = new Logger("QwenProvider");

const _DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const _QWEN_USER_AGENT = "QwenCode/0.14.3 (darwin; arm64)";

// Stainless SDK headers injected by the official OpenAI Node SDK (v5.x).
// portal.qwen.ai validates these to confirm the official client is being used.
const _STAINLESS_HEADERS: Record<string, string> = {
	"X-Stainless-Lang": "js",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Runtime-Version": "v22.17.0",
	"X-Stainless-Os": "MacOS",
	"X-Stainless-Arch": "arm64",
	"X-Stainless-Package-Version": "5.11.0",
	"X-Stainless-Retry-Count": "0",
};

// All Anthropic model tiers map to coder-model (Qwen's unified coding model)
const QWEN_MODEL_MAPPINGS = {
	opus: "coder-model",
	sonnet: "coder-model",
	haiku: "coder-model",
};

// Lines in the Claude Code system prompt that are environment/model-specific
// and should be dropped entirely when proxying to Qwen.
const DROP_LINE_PATTERNS = [
	/You are powered by the model named/,
	/The most recent Claude model family is/,
	/Claude Code is available as a CLI/,
	/Fast mode for Claude Code/,
	/claude\.ai\/code/,
];

/**
 * Adapt a Claude Code system prompt block for Qwen/DashScope:
 * - Replace Claude Code identity with Qwen Code identity
 * - Replace CLAUDE.md references with QWEN.md
 * - Replace /help feedback link with qwen-code's /bug command
 * - Drop lines that reference Claude-specific model names or availability
 */
function sanitizeForQwen(text: string): string {
	// Replace identity line (block [1] is exactly this string)
	if (
		text === "You are Claude Code, Anthropic's official CLI for Claude." ||
		text ===
			"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." ||
		text === "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	) {
		return "You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.";
	}

	// Process line-by-line for the main instructions block
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		// Drop Claude-specific environment/model lines entirely
		if (DROP_LINE_PATTERNS.some((re) => re.test(line))) continue;

		let l = line;
		// CLAUDE.md → QWEN.md
		l = l.replace(/\bCLAUDE\.md\b/g, "QWEN.md");
		// /help feedback line
		l = l.replace(
			/To give feedback, users should report the issue at https:\/\/github\.com\/anthropics\/claude-code\/issues/,
			"To report a bug or provide feedback, please use the /bug command",
		);
		// "Get help with using Claude Code"
		l = l.replace(
			/Get help with using Claude Code/,
			"Get help with using Qwen Code",
		);
		out.push(l);
	}
	return out.join("\n");
}

export class QwenProvider extends OpenAICompatibleProvider {
	override name = "qwen";

	/**
	 * Override to save raw Qwen SSE to /tmp for debugging tool call chunks.
	 * Remove once incremental argument handling is confirmed working.

	override async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token) {
			throw new Error(`No refresh token available for account ${account.name}`);
		}

		const result = await refreshQwenTokens(account.refresh_token);

		return {
			accessToken: result.accessToken,
			expiresAt: Date.now() + result.expiresIn * 1000,
			refreshToken: result.refreshToken,
		};
	}

	override buildUrl(path: string, query: string, account?: Account): string {
		let endpoint: string;
		try {
			endpoint = account ? getEndpointUrl(account) : DEFAULT_ENDPOINT;
			endpoint = validateEndpointUrl(endpoint, "endpoint");
		} catch (error) {
			log.error(
				`Invalid endpoint for account ${account?.name || "unknown"}, using default: ${error instanceof Error ? error.message : String(error)}`,
			);
			endpoint = DEFAULT_ENDPOINT;
		}

		// Convert Anthropic paths to OpenAI-compatible paths (inherited logic)
		let openaiPath = convertAnthropicPathToOpenAI(path);
		if (endpoint.endsWith("/v1") && openaiPath.startsWith("/v1/")) {
			openaiPath = openaiPath.replace(/^\/v1/, "");
		}

		return `${endpoint}${openaiPath}${query}`;
	}

	override prepareHeaders(
		_headers: Headers,
		accessToken?: string,
		_apiKey?: string,
	): Headers {
		// Start from a clean set — DashScope is sensitive to unexpected headers
		// (e.g. x-stainless-*, anthropic-*, accept-encoding) causing 429s.
		const newHeaders = new Headers();

		// Set Qwen auth headers
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
		}

		// Qwen/DashScope SDK headers (verified against qwen-code repo)
		newHeaders.set("Content-Type", "application/json");
		newHeaders.set("User-Agent", QWEN_USER_AGENT);
		newHeaders.set("X-DashScope-CacheControl", "enable");
		newHeaders.set("X-DashScope-UserAgent", QWEN_USER_AGENT);
		newHeaders.set("X-DashScope-AuthType", "qwen-oauth");

		// Stainless SDK headers — portal.qwen.ai validates these to confirm
		// the official OpenAI Node SDK is being used (mimics openai npm pkg v5.x)
		for (const [key, value] of Object.entries(STAINLESS_HEADERS)) {
			newHeaders.set(key, value);
		}
		newHeaders.set("Accept-Language", "*");
		newHeaders.set("Accept-Encoding", "gzip, deflate");
		newHeaders.set("Sec-Fetch-Mode", "cors");
		newHeaders.set("Connection", "keep-alive");

		return newHeaders;
	}

	override parseRateLimit(_response: Response): RateLimitInfo {
		// Qwen handles its own rate limiting — never mark as rate-limited
		// Quota errors come as 403s and are handled inline by the API
		return {
			isRateLimited: false,
			statusHeader: "allowed",
		};
	}

	override supportsOAuth(): boolean {
		return true;
	}

	override supportsUsageTracking(): boolean {
		return true;
	}

	/**
	 * Inject Qwen-specific model mappings when the account has no custom mappings.
	 */
	override beforeConvert(
		_body: Record<string, unknown>,
		account?: Account,
	): Account | undefined {
		if (!account) return account;
		return {
			...account,
			model_mappings:
				account.model_mappings ?? JSON.stringify(QWEN_MODEL_MAPPINGS),
		};
	}

	/**
	 * Inject Qwen-specific fields after converting to OpenAI format.
	 */
	override afterConvert(body: OpenAIRequest): void {
		for (const msg of body.messages) {
			if (msg.role === "system" && Array.isArray(msg.content)) {
				msg.content = msg.content
					// Strip Anthropic billing header blocks
					.filter(
						(block) =>
							!(
								block.type === "text" &&
								typeof block.text === "string" &&
								block.text.startsWith("x-anthropic-")
							),
					)
					// Replace Claude-specific identity and environment blocks
					.map((block) => {
						if (block.type !== "text" || typeof block.text !== "string")
							return block;
						return { ...block, text: sanitizeForQwen(block.text) };
					})
					// Drop blocks that became empty after sanitization
					.filter(
						(block) =>
							block.type !== "text" ||
							typeof block.text !== "string" ||
							block.text.trim() !== "",
					);

				if (msg.content.length === 0) {
					msg.content = "";
				}
			}
		}

		// Enable vision support (coder-model supports vision)
		(body as unknown as Record<string, unknown>).vl_high_resolution_images =
			true;
	}
}
