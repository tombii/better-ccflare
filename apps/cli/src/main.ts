#!/usr/bin/env bun
// Load .env file to ensure environment variables are available
import { config } from "dotenv";

// Load .env with robust path resolution for different deployment scenarios:
// 1. Current directory (when binary is in project root)
// 2. Project root (when running from source with bun run)
// 3. Executable directory (when binary is deployed elsewhere)
const possibleEnvPaths = [
	".env", // Current directory
	"../../.env", // Project root from apps/cli/src
];

// For deployed binaries, also check the executable's directory
if (process.argv[1]) {
	const execPath = require("node:path").dirname(
		require("node:path").resolve(process.argv[1]),
	);
	possibleEnvPaths.push(require("node:path").join(execPath, ".env"));
}

// Try each possible .env location
for (const envPath of possibleEnvPaths) {
	const result = config({ path: envPath });
	if (result.parsed && Object.keys(result.parsed).length > 0) {
		break; // Stop after finding the first .env with variables
	}
}

import {
	addAccount,
	analyzePerformance,
	clearRequestHistory,
	compactDatabase,
	deleteApiKey,
	disableApiKey,
	enableApiKey,
	forceResetRateLimit,
	formatApiKeyForDisplay,
	formatApiKeyGenerationResult,
	generateApiKey,
	getAccountsList,
	getApiKeyStats,
	handleRepairCommand,
	listApiKeys,
	pauseAccount,
	reauthenticateAccount,
	removeAccount,
	resetAllStats,
	resumeAccount,
	runDoctor,
	setAccountPriority,
} from "@better-ccflare/cli-commands";
import { Config } from "@better-ccflare/config";
import {
	CLAUDE_MODEL_IDS,
	getVersionSync,
	levenshteinDistance,
	NETWORK,
	shutdown,
} from "@better-ccflare/core";
import { container, SERVICE_KEYS } from "@better-ccflare/core-di";
import { DatabaseFactory } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import { parseBedrockConfig } from "@better-ccflare/providers";
// Import server
import startServer from "@better-ccflare/server";

interface ParsedArgs {
	version: boolean;
	help: boolean;
	serve: boolean;
	port: number | null;
	sslKey: string | null;
	sslCert: string | null;
	stats: boolean;
	addAccount: string | null;
	mode:
		| "claude-oauth"
		| "console"
		| "zai"
		| "minimax"
		| "anthropic-compatible"
		| "openai-compatible"
		| "nanogpt"
		| "bedrock"
		| "kilo"
		| "alibaba-coding-plan"
		| "codex"
		| "ollama"
		| null;
	priority: number | null;
	profile: string | null;
	crossRegionMode?: "geographic" | "global" | "regional";
	list: boolean;
	remove: string | null;
	pause: string | null;
	resume: string | null;
	setPriority: [string, number] | null;
	reauthenticate: string | null;
	analyze: boolean;
	repairDb: boolean;
	doctor: boolean;
	doctorFull: boolean;
	doctorRecover: boolean;
	resetStats: boolean;
	clearHistory: boolean;
	compact: boolean;
	getModel: boolean;
	setModel: string | null;
	generateApiKey: string | null;
	listApiKeys: boolean;
	disableApiKey: string | null;
	enableApiKey: string | null;
	deleteApiKey: string | null;
	forceResetRateLimit: string | null;
	showConfig: boolean;
}

/**
 * Helper function to start server with unified environment variable handling
 */
function startServerWithConfig(args: ParsedArgs, config: Config) {
	const runtime = config.getRuntime();

	// Proper precedence: command line args > environment variables > config defaults
	const port = args.port || runtime.port || NETWORK.DEFAULT_PORT;
	const sslKeyPath = args.sslKey || process.env.SSL_KEY_PATH;
	const sslCertPath = args.sslCert || process.env.SSL_CERT_PATH;

	// Update URL display based on whether SSL is enabled
	const protocol = sslKeyPath && sslCertPath ? "https" : "http";
	console.log(`Server will be available at ${protocol}://localhost:${port}`);
	console.log(
		`Dashboard will be available at ${protocol}://localhost:${port}/dashboard`,
	);

	startServer({
		port,
		withDashboard: true,
		sslKeyPath,
		sslCertPath,
	});
}

/**
 * Helper function to exit gracefully with proper cleanup
 */
async function exitGracefully(code: 0 | 1 = 0): Promise<never> {
	try {
		await shutdown();
	} catch (error) {
		console.error("Error during shutdown:", error);
	}
	process.exit(code);
}

/**
 * Fast exit function for simple commands that don't need full cleanup
 */
function fastExit(code: 0 | 1 = 0): never {
	process.exit(code);
}

/**
 * Helper function to suggest similar mode values for common typos
 */
function getModeSuggestions(input: string, validModes: string[]): string[] {
	const suggestions: string[] = [];

	for (const mode of validModes) {
		// Check for exact case-insensitive match
		if (mode.toLowerCase() === input.toLowerCase()) {
			continue; // Skip if it's the same (case-insensitive)
		}

		// Check for simple typos using edit distance
		const distance = levenshteinDistance(input, mode);
		if (distance <= 2) {
			// Allow up to 2 character differences
			suggestions.push(mode);
		}
	}

	return suggestions.slice(0, 3); // Return up to 3 suggestions
}

/**
 * Display all configuration variables with their sources and precedence
 */
function displayConfigInfo(parsed: ParsedArgs, config: Config): void {
	const runtime = config.getRuntime();
	const { getPlatformConfigDir } = require("@better-ccflare/config");
	const { resolveDbPath } = require("@better-ccflare/database");

	interface ConfigItem {
		name: string;
		value: string | number | boolean | undefined;
		source: string;
		description: string;
	}

	const configItems: ConfigItem[] = [];

	// Helper to determine source with precedence
	const getSource = (
		cliValue: unknown,
		envVarName: string,
		configValue: unknown,
	): string => {
		if (cliValue !== null && cliValue !== undefined) {
			return "CLI argument";
		}
		if (process.env[envVarName]) {
			return `Environment (${envVarName})`;
		}
		if (configValue !== undefined) {
			return "Config file";
		}
		return "Default";
	};

	// Server Configuration
	configItems.push({
		name: "Port",
		value: parsed.port || process.env.PORT || runtime.port,
		source: getSource(parsed.port, "PORT", undefined),
		description: "Server port",
	});

	configItems.push({
		name: "Host",
		value: process.env.BETTER_CCFLARE_HOST || "0.0.0.0",
		source: process.env.BETTER_CCFLARE_HOST
			? "Environment (BETTER_CCFLARE_HOST)"
			: "Default",
		description: "Server binding host",
	});

	configItems.push({
		name: "SSL Key Path",
		value: parsed.sslKey || process.env.SSL_KEY_PATH || "(not set)",
		source: getSource(parsed.sslKey, "SSL_KEY_PATH", undefined),
		description: "SSL private key path",
	});

	configItems.push({
		name: "SSL Cert Path",
		value: parsed.sslCert || process.env.SSL_CERT_PATH || "(not set)",
		source: getSource(parsed.sslCert, "SSL_CERT_PATH", undefined),
		description: "SSL certificate path",
	});

	// OAuth Configuration
	configItems.push({
		name: "OAuth Client ID",
		value: process.env.CLIENT_ID || runtime.clientId,
		source: process.env.CLIENT_ID ? "Environment (CLIENT_ID)" : "Default",
		description: "OAuth client ID",
	});

	// Database Configuration
	configItems.push({
		name: "Database Path",
		value: process.env.BETTER_CCFLARE_DB_PATH || resolveDbPath(),
		source: process.env.BETTER_CCFLARE_DB_PATH
			? "Environment (BETTER_CCFLARE_DB_PATH)"
			: "Default",
		description: "SQLite database file path",
	});

	configItems.push({
		name: "Config Directory",
		value: getPlatformConfigDir(),
		source: "System",
		description: "Configuration directory",
	});

	// Load Balancing
	configItems.push({
		name: "Load Balancing Strategy",
		value: config.getStrategy(),
		source: process.env.LB_STRATEGY
			? "Environment (LB_STRATEGY)"
			: config.get("lb_strategy")
				? "Config file"
				: "Default",
		description: "Load balancing algorithm",
	});

	configItems.push({
		name: "Session Duration",
		value: `${runtime.sessionDurationMs}ms`,
		source: process.env.SESSION_DURATION_MS
			? "Environment (SESSION_DURATION_MS)"
			: "Default",
		description: "Session persistence duration",
	});

	// Retry Configuration
	configItems.push({
		name: "Retry Attempts",
		value: runtime.retry.attempts,
		source: process.env.RETRY_ATTEMPTS
			? "Environment (RETRY_ATTEMPTS)"
			: "Default",
		description: "Number of retry attempts",
	});

	configItems.push({
		name: "Retry Delay",
		value: `${runtime.retry.delayMs}ms`,
		source: process.env.RETRY_DELAY_MS
			? "Environment (RETRY_DELAY_MS)"
			: "Default",
		description: "Initial retry delay",
	});

	configItems.push({
		name: "Retry Backoff",
		value: runtime.retry.backoff,
		source: process.env.RETRY_BACKOFF
			? "Environment (RETRY_BACKOFF)"
			: "Default",
		description: "Retry backoff multiplier",
	});

	// Agent Configuration
	configItems.push({
		name: "Default Agent Model",
		value: config.getDefaultAgentModel(),
		source: process.env.DEFAULT_AGENT_MODEL
			? "Environment (DEFAULT_AGENT_MODEL)"
			: config.get("default_agent_model")
				? "Config file"
				: "Default",
		description: "Default Claude model for agents",
	});

	// Data Retention
	configItems.push({
		name: "Data Retention",
		value: `${config.getDataRetentionDays()} days`,
		source: process.env.DATA_RETENTION_DAYS
			? "Environment (DATA_RETENTION_DAYS)"
			: config.get("data_retention_days")
				? "Config file"
				: "Default",
		description: "Payload data retention period",
	});

	configItems.push({
		name: "Request Retention",
		value: `${config.getRequestRetentionDays()} days`,
		source: process.env.REQUEST_RETENTION_DAYS
			? "Environment (REQUEST_RETENTION_DAYS)"
			: config.get("request_retention_days")
				? "Config file"
				: "Default",
		description: "Request metadata retention period",
	});

	configItems.push({
		name: "Store Payloads",
		value: config.getStorePayloads(),
		source: process.env.STORE_PAYLOADS
			? "Environment (STORE_PAYLOADS)"
			: config.get("store_payloads") !== undefined
				? "Config file"
				: "Default",
		description:
			"Store request/response bodies in DB (disable to reduce DB size)",
	});

	// Logging Configuration
	configItems.push({
		name: "Log Level",
		value: process.env.LOG_LEVEL || "INFO",
		source: process.env.LOG_LEVEL ? "Environment (LOG_LEVEL)" : "Default",
		description: "Logging verbosity level",
	});

	configItems.push({
		name: "Log Format",
		value: process.env.LOG_FORMAT || "text",
		source: process.env.LOG_FORMAT ? "Environment (LOG_FORMAT)" : "Default",
		description: "Log output format",
	});

	// Print configuration
	const version = getVersionSync();
	console.log(`
⚙️  better-ccflare v${version} - Configuration

Configuration Precedence: CLI arguments > Environment variables > Config file > Defaults

`);

	// Find the longest name for padding
	const maxNameLength = Math.max(
		...configItems.map((item) => item.name.length),
	);
	const maxValueLength = Math.max(
		...configItems.map((item) => String(item.value).length),
	);

	for (const item of configItems) {
		const namePadded = item.name.padEnd(maxNameLength);
		const valuePadded = String(item.value).padEnd(maxValueLength);
		const sourceIndicator =
			item.source.startsWith("CLI") || item.source.startsWith("Environment")
				? "✓"
				: item.source === "Config file"
					? "📄"
					: "⚙️";
		console.log(
			`${sourceIndicator} ${namePadded}  ${valuePadded}  [${item.source}]`,
		);
	}

	console.log(`
Legend:
  ✓  Overridden (CLI argument or environment variable)
  📄 Config file setting
  ⚙️  Default value
`);
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): ParsedArgs {
	const parsed: ParsedArgs = {
		version: false,
		help: false,
		serve: false, // Keep for backwards compatibility but treat as no-op
		port: null,
		sslKey: null,
		sslCert: null,
		stats: false,
		addAccount: null,
		mode: null,
		priority: null,
		profile: null,
		crossRegionMode: undefined,
		list: false,
		remove: null,
		pause: null,
		resume: null,
		setPriority: null,
		reauthenticate: null,
		analyze: false,
		repairDb: false,
		doctor: false,
		doctorFull: false,
		doctorRecover: false,
		resetStats: false,
		clearHistory: false,
		compact: false,
		getModel: false,
		setModel: null,
		generateApiKey: null,
		listApiKeys: false,
		disableApiKey: null,
		enableApiKey: null,
		deleteApiKey: null,
		forceResetRateLimit: null,
		showConfig: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		switch (arg) {
			case "--version":
			case "-v":
				parsed.version = true;
				break;
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--serve":
				parsed.serve = true;
				break;
			case "--port":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --port requires a value");
					fastExit(1);
				}
				parsed.port = parseInt(args[++i], 10);
				if (
					Number.isNaN(parsed.port) ||
					parsed.port < 1 ||
					parsed.port > 65535
				) {
					console.error(`❌ Invalid port: ${args[i]}`);
					console.error("Port must be a number between 1 and 65535");
					fastExit(1);
				}
				break;
			case "--ssl-key":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --ssl-key requires a path");
					fastExit(1);
				}
				parsed.sslKey = args[++i];
				break;
			case "--ssl-cert":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --ssl-cert requires a path");
					fastExit(1);
				}
				parsed.sslCert = args[++i];
				break;
			case "--stats":
				parsed.stats = true;
				break;
			case "--add-account":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --add-account requires an account name");
					fastExit(1);
				}
				parsed.addAccount = args[++i];
				break;
			case "--mode": {
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --mode requires a value");
					fastExit(1);
				}
				let modeValue = args[++i] as
					| "claude-oauth"
					| "console"
					| "zai"
					| "minimax"
					| "anthropic-compatible"
					| "openai-compatible"
					| "nanogpt"
					| "bedrock"
					| "kilo"
					| "alibaba-coding-plan"
					| "codex"
					| "ollama"
					| "max";

				// Handle deprecated "max" mode with warning
				if (modeValue === "max") {
					console.warn(
						'⚠️  Mode "max" is deprecated. Please use "claude-oauth" instead.',
					);
					modeValue = "claude-oauth";
				}

				parsed.mode = modeValue as
					| "claude-oauth"
					| "console"
					| "zai"
					| "minimax"
					| "nanogpt"
					| "anthropic-compatible"
					| "openai-compatible"
					| "bedrock"
					| "kilo"
					| "alibaba-coding-plan"
					| "codex"
					| "ollama";
				const validModes: Array<
					| "claude-oauth"
					| "console"
					| "zai"
					| "minimax"
					| "nanogpt"
					| "anthropic-compatible"
					| "openai-compatible"
					| "bedrock"
					| "kilo"
					| "alibaba-coding-plan"
					| "codex"
					| "ollama"
				> = [
					"claude-oauth",
					"console",
					"zai",
					"minimax",
					"nanogpt",
					"anthropic-compatible",
					"openai-compatible",
					"bedrock",
					"kilo",
					"alibaba-coding-plan",
					"codex",
					"ollama",
				];
				if (!validModes.includes(modeValue)) {
					console.error(`❌ Invalid mode: ${modeValue}`);
					console.error(`Valid modes: ${validModes.join(", ")}`);

					// Provide suggestions for common typos
					const suggestions = getModeSuggestions(modeValue, validModes);
					if (suggestions.length > 0) {
						console.error(`Did you mean: ${suggestions.join(", ")}?`);
					}

					console.error("\nExamples:");
					console.error(
						"  bun run cli --add-account my-account --mode claude-oauth --priority 0",
					);
					console.error(
						"  bun run cli --add-account api-key-account --mode console --priority 10",
					);
					console.error(
						"  bun run cli --add-account zai-account --mode zai --priority 20",
					);
					console.error(
						"  bun run cli --add-account minimax-account --mode minimax --priority 30",
					);
					console.error(
						"  bun run cli --add-account openai-account --mode openai-compatible --priority 40",
					);
					console.error(
						"  bun run cli --add-account anthropic-account --mode anthropic-compatible --priority 50",
					);
					console.error(
						"  bun run cli --add-account bedrock-account --mode bedrock --profile default",
					);

					fastExit(1);
				}
				break;
			}
			case "--priority":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --priority requires a value");
					fastExit(1);
				}
				parsed.priority = parseInt(args[++i], 10);
				if (Number.isNaN(parsed.priority)) {
					console.error(`❌ Invalid priority: ${args[i]}`);
					console.error("Priority must be a number");
					fastExit(1);
				}
				break;
			case "--profile":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --profile requires a value");
					fastExit(1);
				}
				parsed.profile = args[++i];
				break;
			case "--cross-region-mode": {
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --cross-region-mode requires a value");
					fastExit(1);
				}
				const crossRegionValue = args[++i];
				if (
					crossRegionValue !== "geographic" &&
					crossRegionValue !== "global" &&
					crossRegionValue !== "regional"
				) {
					console.error(
						"Invalid --cross-region-mode value. Must be one of: geographic, global, regional",
					);
					fastExit(1);
				}
				parsed.crossRegionMode = crossRegionValue as
					| "geographic"
					| "global"
					| "regional";
				break;
			}
			case "--list":
				parsed.list = true;
				break;
			case "--remove":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --remove requires an account name");
					fastExit(1);
				}
				parsed.remove = args[++i];
				break;
			case "--pause":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --pause requires an account name");
					fastExit(1);
				}
				parsed.pause = args[++i];
				break;
			case "--resume":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --resume requires an account name");
					fastExit(1);
				}
				parsed.resume = args[++i];
				break;
			case "--set-priority": {
				if (
					i + 2 >= args.length ||
					args[i + 1].startsWith("--") ||
					args[i + 2].startsWith("--")
				) {
					console.error(
						"❌ --set-priority requires an account name and priority",
					);
					fastExit(1);
				}
				const name = args[++i];
				const priority = parseInt(args[++i], 10);
				parsed.setPriority = [name, priority];
				break;
			}
			case "--analyze":
				parsed.analyze = true;
				break;
			case "--repair-db":
				parsed.repairDb = true;
				break;
			case "--doctor":
				parsed.doctor = true;
				break;
			case "--doctor-full":
				parsed.doctorFull = true;
				parsed.doctor = true; // Base flag
				break;
			case "--doctor-recover":
				parsed.doctorRecover = true;
				parsed.doctor = true; // Base flag
				break;
			case "--reset-stats":
				parsed.resetStats = true;
				break;
			case "--clear-history":
				parsed.clearHistory = true;
				break;
			case "--compact":
				parsed.compact = true;
				break;
			case "--get-model":
				parsed.getModel = true;
				break;
			case "--set-model":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --set-model requires a model name");
					fastExit(1);
				}
				parsed.setModel = args[++i];
				break;
			case "--generate-api-key":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --generate-api-key requires a name");
					fastExit(1);
				}
				parsed.generateApiKey = args[++i];
				break;
			case "--list-api-keys":
				parsed.listApiKeys = true;
				break;
			case "--disable-api-key":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --disable-api-key requires an API key name");
					fastExit(1);
				}
				parsed.disableApiKey = args[++i];
				break;
			case "--enable-api-key":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --enable-api-key requires an API key name");
					fastExit(1);
				}
				parsed.enableApiKey = args[++i];
				break;
			case "--delete-api-key":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --delete-api-key requires an API key name");
					fastExit(1);
				}
				parsed.deleteApiKey = args[++i];
				break;
			case "--reauthenticate":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --reauthenticate requires an account name");
					fastExit(1);
				}
				parsed.reauthenticate = args[++i];
				break;
			case "--force-reset-rate-limit":
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
					console.error("❌ --force-reset-rate-limit requires an account name");
					fastExit(1);
				}
				parsed.forceResetRateLimit = args[++i];
				break;
			case "--show-config":
				parsed.showConfig = true;
				break;
		}
	}

	return parsed;
}

async function main() {
	const args = process.argv.slice(2);
	const parsed = parseArgs(args);

	// Handle version - check before any expensive initializations
	if (parsed.version) {
		// Use sync version to avoid async overhead
		const version = getVersionSync();
		console.log(`better-ccflare v${version}`);
		fastExit(0);
		return;
	}

	// Handle show-config - check before full DI initialization but after config
	if (parsed.showConfig) {
		const config = new Config();
		displayConfigInfo(parsed, config);
		fastExit(0);
		return;
	}

	// Handle help - check before any expensive initializations
	if (parsed.help) {
		// Use sync version to avoid async overhead
		const version = getVersionSync();
		console.log(`
🎯 better-ccflare v${version} - Load Balancer for Claude

Usage: better-ccflare [options]

Options:
  --version, -v       Show version number
  --serve              Start API server with dashboard
  --port <number>      Server port (default: 8080, or PORT env var)
  --ssl-key <path>     Path to SSL private key file (enables HTTPS)
  --ssl-cert <path>    Path to SSL certificate file (enables HTTPS)
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --mode <claude-oauth|console|zai|minimax|nanogpt|anthropic-compatible|openai-compatible|bedrock|kilo|alibaba-coding-plan|codex>  Account mode (default: claude-oauth)
      claude-oauth: Claude CLI account (OAuth)
      console: Claude API account (OAuth)
      zai: z.ai account (API key)
      minimax: Minimax account (API key)
      nanogpt: NanoGPT provider (API key)
      anthropic-compatible: Anthropic-compatible provider (API key)
      openai-compatible: OpenAI-compatible provider (API key)
      bedrock: AWS Bedrock account (AWS profile credentials)
        --profile <name>  AWS profile name from ~/.aws/credentials (required)
        --cross-region-mode <mode>   Cross-region inference mode: geographic (default), global, or regional
      kilo: Kilo Gateway provider (API key)
      alibaba-coding-plan: Alibaba Coding Plan International provider (API key)
      codex: Codex (OpenAI OAuth) provider
    --priority <number>   Account priority (default: 0)
  --list               List all accounts
  --remove <name>      Remove an account
  --reauthenticate <name> Re-authenticate an account (preserves metadata)
  --pause <name>       Pause an account
  --resume <name>      Resume an account
  --force-reset-rate-limit <name> Force-clear stale rate-limit lock for an account
  --set-priority <name> <priority>  Set account priority
  --analyze            Analyze database performance
  --repair-db          Check and repair database integrity
  --doctor             Run database integrity check and storage diagnostics
  --doctor-full        Run exhaustive integrity check (slower)
  --doctor-recover     Generate recovery instructions for corrupted database
  --reset-stats        Reset usage statistics
  --clear-history      Clear request history
  --compact            Compact database (WAL checkpoint + VACUUM)
  --get-model          Show current default agent model
  --set-model <model>  Set default agent model (opus-4 or sonnet-4)

API Key Management:
  --generate-api-key <name>  Generate a new API key
  --list-api-keys            List all API keys
  --disable-api-key <name>   Disable an API key
  --enable-api-key <name>    Enable a disabled API key
  --delete-api-key <name>    Delete an API key permanently

Debugging:
  --show-config              Show all configuration variables with their sources
  --help, -h                 Show this help message

Examples:
  better-ccflare --serve                # Start server
  better-ccflare --serve --ssl-key /path/to/key.pem --ssl-cert /path/to/cert.pem  # Start server with HTTPS
  better-ccflare --add-account work --mode claude-oauth --priority 0  # Add account
  better-ccflare --add-account my-bedrock --mode bedrock --profile default  # Add Bedrock account
  better-ccflare --reauthenticate work  # Re-authenticate account (preserves metadata)
  better-ccflare --force-reset-rate-limit work  # Force-clear stale rate-limit lock
  better-ccflare --pause work           # Pause account
  better-ccflare --analyze              # Run performance analysis
  better-ccflare --stats                # View stats
  better-ccflare --generate-api-key "My App"   # Generate a new API key
  better-ccflare --list-api-keys               # List all API keys
  better-ccflare --disable-api-key "My App"    # Disable an API key
`);
		fastExit(0);
		return;
	}

	// Handle commands that don't need database or DI initialization
	if (parsed.getModel || parsed.setModel) {
		// Initialize only config for these simple commands
		const config = new Config();

		if (parsed.getModel) {
			const model = config.getDefaultAgentModel();
			console.log(`Current default agent model: ${model}`);
			fastExit(0);
			return;
		}

		if (parsed.setModel) {
			// Validate the model
			const modelMap: Record<string, string> = {
				"opus-4": CLAUDE_MODEL_IDS.OPUS_4,
				"sonnet-4": CLAUDE_MODEL_IDS.SONNET_4,
				"opus-4.1": CLAUDE_MODEL_IDS.OPUS_4_1,
				"sonnet-4.5": CLAUDE_MODEL_IDS.SONNET_4_5,
				"sonnet-4.6": CLAUDE_MODEL_IDS.SONNET_4_6,
			};

			const fullModel = modelMap[parsed.setModel];
			if (!fullModel) {
				console.error(`❌ Invalid model: ${parsed.setModel}`);
				console.error(`Valid models: ${Object.keys(modelMap).join(", ")}`);
				fastExit(1);
				return;
			}

			config.setDefaultAgentModel(fullModel);
			console.log(`✅ Default agent model set to: ${fullModel}`);
			fastExit(0);
			return;
		}
	}

	// Initialize DI container and services for commands that need them
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("CLI"));

	// Initialize database factory with minimal configuration for CLI commands
	// CLI commands don't need expensive integrity checks
	DatabaseFactory.initialize(undefined, undefined, false);
	const dbOps = DatabaseFactory.getInstance(false);
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	// Handle non-interactive commands
	if (parsed.serve) {
		const config = new Config();
		startServerWithConfig(parsed, config);
		// Keep process alive
		await new Promise(() => {});
		return;
	}

	if (parsed.stats) {
		const accounts = await getAccountsList(dbOps);
		const stats = {
			totalAccounts: accounts.length,
			activeAccounts: accounts.filter(
				(acc) => !acc.paused && acc.tokenStatus === "valid",
			).length,
			pausedAccounts: accounts.filter((acc) => acc.paused).length,
			expiredAccounts: accounts.filter((acc) => acc.tokenStatus === "expired")
				.length,
			totalRequests: accounts.reduce((sum, acc) => sum + acc.requestCount, 0),
			accounts: accounts.map((acc) => ({
				name: acc.name,
				provider: acc.provider,
				mode: acc.mode,
				priority: acc.priority,
				requestCount: acc.requestCount,
				paused: acc.paused,
				tokenStatus: acc.tokenStatus,
				rateLimitStatus: acc.rateLimitStatus,
			})),
		};
		console.log(JSON.stringify(stats, null, 2));
		await exitGracefully(0);
	}

	if (parsed.addAccount) {
		// Require explicit --mode flag to avoid silent defaults
		if (!parsed.mode) {
			console.error("❌ Please provide --mode to specify account type");
			console.error("Available modes:");
			console.error(
				"  --mode claude-oauth    Claude CLI OAuth account (Max subscription)",
			);
			console.error("  --mode console         Claude API account (OAuth)");
			console.error("  --mode zai             z.ai account (API key)");
			console.error("  --mode minimax         Minimax account (API key)");
			console.error("  --mode nanogpt         NanoGPT account (API key)");
			console.error(
				"  --mode anthropic-compatible  Anthropic-compatible provider",
			);
			console.error(
				"  --mode openai-compatible     OpenAI-compatible provider",
			);
			console.error("  --mode bedrock         AWS Bedrock (AWS profile)");
			console.error("  --mode kilo            Kilo Gateway provider (API key)");
			console.error(
				"  --mode alibaba-coding-plan  Alibaba Coding Plan International (API key)",
			);
			console.error(
				"  --mode codex               Codex (OpenAI OAuth) provider",
			);
			console.error("\nExample:");
			console.error(
				"  better-ccflare --add-account work --mode claude-oauth --priority 0",
			);
			await exitGracefully(1);
		}

		try {
			// Mode is guaranteed non-null by guard above
			const mode = parsed.mode as Exclude<typeof parsed.mode, undefined | null>;
			const priority = parsed.priority || 0;

			// OAuth modes need interactive prompts for the auth code
			const needsInteractiveAuth =
				mode === "claude-oauth" || mode === "console" || mode === "codex";

			if (needsInteractiveAuth) {
				// Use real prompt adapter for OAuth - needs user to paste auth code
				const { stdPromptAdapter } = await import(
					"@better-ccflare/cli-commands"
				);
				await addAccount(dbOps, new Config(), {
					name: parsed.addAccount,
					mode,
					priority,
					adapter: stdPromptAdapter,
				});
			} else if (mode === "bedrock") {
				// Bedrock uses AWS profiles, not API keys
				if (!parsed.profile) {
					console.error("❌ --profile flag is required for bedrock mode");
					console.error(
						"Example: bun run cli --add-account my-bedrock --mode bedrock --profile default",
					);
					await exitGracefully(1);
				}
				await addAccount(dbOps, new Config(), {
					name: parsed.addAccount,
					mode: "bedrock",
					priority,
					profile: parsed.profile || undefined,
					crossRegionMode: parsed.crossRegionMode,
					adapter: {
						select: async <T extends string | number>(
							_prompt: string,
							_options: Array<{ label: string; value: T }>,
						) => (_options[0]?.value as T) || ("yes" as T),
						input: async (_prompt: string) => "",
						confirm: async (_prompt: string) => true,
					},
				});
			} else if (
				mode === "anthropic-compatible" ||
				mode === "openai-compatible"
			) {
				// These modes need interactive prompts for endpoint + API key
				const { stdPromptAdapter } = await import(
					"@better-ccflare/cli-commands"
				);
				await addAccount(dbOps, new Config(), {
					name: parsed.addAccount,
					mode,
					priority,
					profile: parsed.profile || undefined,
					adapter: stdPromptAdapter,
				});
			} else {
				// For API key accounts, get the API key from environment or prompt
				let apiKey =
					process.env[
						`BETTER_CCFLARE_API_KEY_${parsed.addAccount.toUpperCase()}`
					] ||
					process.env[`API_KEY_${parsed.addAccount.toUpperCase()}`] ||
					"";

				if (!apiKey) {
					// Prompt for API key if not in environment
					const { stdPromptAdapter } = await import(
						"@better-ccflare/cli-commands"
					);
					apiKey = await stdPromptAdapter.input(
						`Enter API key for ${parsed.addAccount}: `,
					);

					if (!apiKey || apiKey.trim() === "") {
						console.error(`❌ API key cannot be empty for ${mode} accounts`);
						await exitGracefully(1);
					}
				}

				await addAccount(dbOps, new Config(), {
					name: parsed.addAccount,
					mode,
					priority,
					adapter: {
						select: async <T extends string | number>(
							_prompt: string,
							_options: Array<{ label: string; value: T }>,
						) => (_options[0]?.value as T) || ("yes" as T),
						input: async (_prompt: string) => apiKey,
						confirm: async (_prompt: string) => true,
					},
				});
			}
			console.log(`✅ Account "${parsed.addAccount}" added successfully`);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(`❌ Failed to add account: ${errorMessage}`);
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.list) {
		const accounts = await getAccountsList(dbOps);
		if (accounts.length === 0) {
			console.log("No accounts configured");
		} else {
			console.log("\nAccounts:");
			accounts.forEach((acc) => {
				if (acc.mode === "bedrock" && acc.customEndpoint) {
					const config = parseBedrockConfig(acc.customEndpoint);
					if (config) {
						console.log(
							`  - ${acc.name} (bedrock, profile=${config.profile}, region=${config.region}, cross_region_mode=${acc.crossRegionMode ?? "geographic"}, priority=${acc.priority})`,
						);
						return;
					}
				}
				console.log(
					`  - ${acc.name} (${acc.mode} mode, priority ${acc.priority})`,
				);
			});
		}
		await exitGracefully(0);
	}

	if (parsed.remove) {
		const result = await removeAccount(dbOps, parsed.remove);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.reauthenticate) {
		try {
			const result = await reauthenticateAccount(
				dbOps,
				new Config(),
				parsed.reauthenticate,
			);
			console.log(result.message);
			if (!result.success) {
				await exitGracefully(1);
			}
			await exitGracefully(0);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(`❌ Failed to reauthenticate account: ${errorMessage}`);
			await exitGracefully(1);
		}
	}

	if (parsed.forceResetRateLimit) {
		try {
			const result = await forceResetRateLimit(
				dbOps,
				parsed.forceResetRateLimit,
				new Config(),
			);
			console.log(result.message);
			if (!result.success) {
				await exitGracefully(1);
			}
			await exitGracefully(0);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(`❌ Failed to force reset rate limit: ${errorMessage}`);
			await exitGracefully(1);
		}
	}

	if (parsed.resetStats) {
		await resetAllStats(dbOps);
		console.log("✅ Statistics reset successfully");
		await exitGracefully(0);
	}

	if (parsed.clearHistory) {
		const cliConfig = container.resolve<Config>(SERVICE_KEYS.Config);
		const result = await clearRequestHistory(dbOps, cliConfig);
		console.log(
			`✅ Request history cleared successfully (${result.removedPayloads} payloads, ${result.removedRequests} requests removed)`,
		);
		await exitGracefully(0);
	}

	if (parsed.compact) {
		const result = await compactDatabase(dbOps);
		if (result.error) {
			console.error(`❌ Database compact failed: ${result.error}`);
			console.error(
				`WAL checkpoint: busy=${result.walBusy}, log=${result.walLog}, checkpointed=${result.walCheckpointed}${result.walTruncateBusy !== undefined ? `, truncateBusy=${result.walTruncateBusy}` : ""}`,
			);
			await exitGracefully(1);
		}
		console.log(
			`✅ Database compact completed (vacuumed=${result.vacuumed}, walBusy=${result.walBusy}, walLog=${result.walLog}, walCheckpointed=${result.walCheckpointed}${result.walTruncateBusy !== undefined ? `, walTruncateBusy=${result.walTruncateBusy}` : ""})`,
		);
		await exitGracefully(0);
	}

	if (parsed.pause) {
		const result = await pauseAccount(dbOps, parsed.pause);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.resume) {
		const result = await resumeAccount(dbOps, parsed.resume);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.setPriority) {
		const [name, priority] = parsed.setPriority;

		if (Number.isNaN(priority)) {
			console.error(`❌ Invalid priority value: ${priority}`);
			await exitGracefully(1);
		}

		const result = await setAccountPriority(dbOps, name, priority);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	// API Key management commands
	if (parsed.generateApiKey) {
		try {
			const result = await generateApiKey(dbOps, parsed.generateApiKey);
			console.log(formatApiKeyGenerationResult(result));
			await exitGracefully(0);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(`❌ Failed to generate API key: ${errorMessage}`);
			await exitGracefully(1);
		}
	}

	if (parsed.listApiKeys) {
		const apiKeys = await listApiKeys(dbOps);
		if (apiKeys.length === 0) {
			console.log("No API keys configured");
		} else {
			console.log("\nAPI Keys:");
			apiKeys.forEach((apiKey) => {
				console.log(formatApiKeyForDisplay(apiKey));
			});

			// Show statistics
			const stats = await getApiKeyStats(dbOps);
			console.log(`\nStatistics:`);
			console.log(`  Total: ${stats.total}`);
			console.log(`  Active: ${stats.active}`);
			console.log(`  Inactive: ${stats.inactive}`);
		}
		await exitGracefully(0);
	}

	if (parsed.disableApiKey) {
		try {
			await disableApiKey(dbOps, parsed.disableApiKey);
			console.log(`✅ API key '${parsed.disableApiKey}' disabled successfully`);
			await exitGracefully(0);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(`❌ Failed to disable API key: ${errorMessage}`);
			await exitGracefully(1);
		}
	}

	if (parsed.enableApiKey) {
		try {
			await enableApiKey(dbOps, parsed.enableApiKey);
			console.log(`✅ API key '${parsed.enableApiKey}' enabled successfully`);
			await exitGracefully(0);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(`❌ Failed to enable API key: ${errorMessage}`);
			await exitGracefully(1);
		}
	}

	if (parsed.deleteApiKey) {
		try {
			await deleteApiKey(dbOps, parsed.deleteApiKey);
			console.log(`✅ API key '${parsed.deleteApiKey}' deleted successfully`);
			await exitGracefully(0);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(`❌ Failed to delete API key: ${errorMessage}`);
			await exitGracefully(1);
		}
	}

	if (parsed.analyze) {
		await analyzePerformance(dbOps);
		await exitGracefully(0);
	}

	if (parsed.repairDb) {
		await handleRepairCommand(dbOps);
		await exitGracefully(0);
	}

	if (parsed.doctor || parsed.doctorFull || parsed.doctorRecover) {
		const { exitCode } = await runDoctor(dbOps, {
			full: parsed.doctorFull,
			recover: parsed.doctorRecover,
		});
		await exitGracefully(exitCode as 0 | 1);
	}

	// Default: Start server if no command specified
	console.log("Starting better-ccflare server...");
	const config = new Config();
	startServerWithConfig(parsed, config);

	// Keep process alive
	await new Promise(() => {});
}

// Run main and handle errors
main().catch(async (error) => {
	console.error("Error:", error.message);
	await exitGracefully(1);
});

// Handle process termination
process.on("SIGINT", async () => {
	await exitGracefully(0);
});

process.on("SIGTERM", async () => {
	await exitGracefully(0);
});
