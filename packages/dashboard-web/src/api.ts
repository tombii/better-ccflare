import {
	HttpClient,
	HttpError,
	type RequestOptions,
} from "@better-ccflare/http-common";
import type {
	AccountResponse,
	Agent,
	AgentUpdatePayload,
	AgentWorkspace,
	AnalyticsResponse,
	Combo,
	ComboFamilyAssignment,
	ComboSlot,
	ComboWithSlots,
	LogEvent,
	RequestPayload,
	RequestResponse,
	StatsWithAccounts,
} from "@better-ccflare/types";
import { API_LIMITS, API_TIMEOUT } from "./constants";

// Re-export types with dashboard-specific aliases for backward compatibility
export type Account = AccountResponse & {
	/** @deprecated Fallbacks are now merged into modelMappings as arrays */
	modelFallbacks?: { [key: string]: string } | null;
};
export type Stats = StatsWithAccounts;
export type LogEntry = LogEvent;
export type RequestSummary = RequestResponse;

// Re-export types directly
export type {
	Agent,
	AgentWorkspace,
	RequestPayload,
	RequestResponse,
} from "@better-ccflare/types";

// Agent response interface
export interface AgentsResponse {
	agents: Agent[];
	globalAgents: Agent[];
	workspaceAgents: Agent[];
	pluginAgents: Agent[];
	workspaces: AgentWorkspace[];
}

// Token health response interfaces
export interface TokenHealthResponse {
	accountId: string;
	accountName: string;
	provider: string;
	hasRefreshToken: boolean;
	status: "healthy" | "warning" | "critical" | "expired" | "no-refresh-token";
	message: string;
	daysUntilExpiration?: number;
	requiresReauth: boolean;
}

export interface TokenHealthGlobalResponse {
	success: boolean;
	data: {
		accounts: TokenHealthResponse[];
	};
}

export interface TokenHealthAccountResponse {
	success: boolean;
	data: TokenHealthResponse;
}

export interface ReauthNeededResponse {
	success: boolean;
	data: {
		accounts: TokenHealthResponse[];
	};
}

class API extends HttpClient {
	private static readonly API_KEY_STORAGE_KEY = "better-ccflare-api-key";

	private logger = {
		info: (message: string, ...args: unknown[]) => {
			console.log(`[API] ${message}`, ...args);
		},
		warn: (message: string, ...args: unknown[]) => {
			console.warn(`[API] ${message}`, ...args);
		},
		error: (message: string, ...args: unknown[]) => {
			console.error(`[API] ${message}`, ...args);
		},
		debug: (message: string, ...args: unknown[]) => {
			console.debug(`[API] ${message}`, ...args);
		},
	};

	constructor() {
		super({
			baseUrl: "",
			defaultHeaders: {
				"Content-Type": "application/json",
			},
			timeout: API_TIMEOUT,
			retries: 1,
		});
	}

	/**
	 * Store API key in localStorage (persists until manually cleared)
	 */
	setApiKey(apiKey: string): void {
		localStorage.setItem(API.API_KEY_STORAGE_KEY, apiKey);
	}

	/**
	 * Retrieve API key from localStorage
	 */
	getApiKey(): string | null {
		return localStorage.getItem(API.API_KEY_STORAGE_KEY);
	}

	/**
	 * Clear stored API key
	 */
	clearApiKey(): void {
		localStorage.removeItem(API.API_KEY_STORAGE_KEY);
	}

	/**
	 * Check if API key is stored
	 */
	hasApiKey(): boolean {
		return !!this.getApiKey();
	}

	/**
	 * Override request method to inject API key into headers and handle 401 errors
	 */
	override async request<T = unknown>(
		url: string,
		options: RequestOptions = {},
	): Promise<T> {
		const apiKey = this.getApiKey();

		if (apiKey) {
			this.logger.debug("Including API key in request to:", url);
			// Merge API key into headers
			const headers = {
				...((options.headers as Record<string, string>) || {}),
				"x-api-key": apiKey,
			};
			options = { ...options, headers };
		} else {
			this.logger.debug("No API key found for request to:", url);
		}

		try {
			return await super.request<T>(url, options);
		} catch (error) {
			// If we get a 401, dispatch a custom event to trigger auth dialog
			if (error instanceof HttpError && error.status === 401) {
				this.logger.warn("401 Unauthorized - dispatching auth required event");
				window.dispatchEvent(new CustomEvent("auth-required"));
			}
			throw error;
		}
	}

	async getStats(opts?: { errorsSinceHours?: number }): Promise<Stats> {
		const startTime = Date.now();
		const hours = opts?.errorsSinceHours;
		const url =
			typeof hours === "number" && Number.isFinite(hours) && hours > 0
				? `/api/stats?errorsSinceHours=${hours}`
				: "/api/stats";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<Stats>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getAccounts(): Promise<Account[]> {
		const startTime = Date.now();
		const url = "/api/accounts";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<Account[]>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async initAddAccount(data: {
		name: string;
		mode:
			| "claude-oauth"
			| "console"
			| "zai"
			| "minimax"
			| "anthropic-compatible"
			| "openai-compatible"
			| "nanogpt"
			| "vertex-ai"
			| "bedrock"
			| "kilo"
			| "openrouter"
			| "alibaba-coding-plan"
			| "codex"
			| "qwen"
			| "ollama";
		apiKey?: string;
		priority: number;
		customEndpoint?: string;
	}): Promise<{ authUrl: string; sessionId: string }> {
		const startTime = Date.now();
		const url = "/api/oauth/init";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ authUrl: string; sessionId: string }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async completeAddAccount(data: {
		sessionId: string;
		code: string;
	}): Promise<{ message: string; mode: string }> {
		const startTime = Date.now();
		const url = "/api/oauth/callback";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{
				message: string;
				mode: string;
			}>(url, data);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addZaiAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/zai";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addOpenAIAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint: string;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/openai-compatible";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addNanoGPTAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/nanogpt";
		this.logger.debug(`→ POST ${url}`, { data });
		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addAlibabaCodingPlanAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/alibaba-coding-plan";
		this.logger.debug(`→ POST ${url}`, { data });
		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addKiloAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/kilo";
		this.logger.debug(`→ POST ${url}`, { data });
		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addOpenRouterAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/openrouter";
		this.logger.debug(`→ POST ${url}`, { data });
		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addMinimaxAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/minimax";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addVertexAIAccount(data: {
		name: string;
		projectId: string;
		region: string;
		priority: number;
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/vertex-ai";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async getAwsProfiles(): Promise<
		Array<{ name: string; region: string | null }>
	> {
		const startTime = Date.now();
		const url = "/api/aws/profiles";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response =
				await this.get<Array<{ name: string; region: string | null }>>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async addBedrockAccount(data: {
		name: string;
		profile: string;
		region: string;
		priority: number;
		cross_region_mode?: "geographic" | "global" | "regional";
		customModel?: string;
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/bedrock";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addAnthropicCompatibleAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/anthropic-compatible";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addOllamaAccount(data: {
		name: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/ollama";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async addOllamaCloudAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}): Promise<{ message: string; account: Account }> {
		const startTime = Date.now();
		const url = "/api/accounts/ollama-cloud";

		this.logger.debug(`→ POST ${url}`, { data });

		try {
			const response = await this.post<{ message: string; account: Account }>(
				url,
				data,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async removeAccount(name: string, confirm: string): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${name}`;

		this.logger.debug(`→ DELETE ${url}`, { confirm });

		try {
			await this.delete(url, {
				body: JSON.stringify({ confirm }),
			});
			const duration = Date.now() - startTime;
			this.logger.debug(`← DELETE ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ DELETE ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async resetStats(): Promise<void> {
		const startTime = Date.now();
		const url = "/api/stats/reset";

		this.logger.debug(`→ POST ${url}`);

		try {
			await this.post(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getLogHistory(): Promise<LogEntry[]> {
		const startTime = Date.now();
		const url = "/api/logs/history";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<LogEntry[]>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	// SSE streaming requires special handling, keep as-is
	streamLogs(onLog: (log: LogEntry) => void): EventSource {
		const eventSource = new EventSource(`/api/logs/stream`);
		eventSource.addEventListener("message", (event) => {
			try {
				const data = JSON.parse(event.data);
				// Skip non-log messages (like the initial "connected" message)
				if (data.ts && data.level && data.msg) {
					onLog(data as LogEntry);
				}
			} catch (e) {
				console.error("Error parsing log event:", e);
			}
		});
		return eventSource;
	}

	async getRequestsDetail(
		limit: number = API_LIMITS.requestsDetail,
	): Promise<RequestPayload[]> {
		const startTime = Date.now();
		const url = `/api/requests/detail?limit=${limit}`;

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<RequestPayload[]>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getRequestPayload(id: string): Promise<RequestPayload> {
		const startTime = Date.now();
		const url = `/api/requests/payload/${encodeURIComponent(id)}`;

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<Omit<RequestPayload, "id">>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return { id, ...response };
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getRequestsSummary(
		limit: number = API_LIMITS.requestsSummary,
	): Promise<RequestSummary[]> {
		const startTime = Date.now();
		const url = `/api/requests?limit=${limit}`;

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<RequestSummary[]>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getAnalytics(
		range = "24h",
		filters?: {
			accounts?: string[];
			models?: string[];
			apiKeys?: string[];
			status?: "all" | "success" | "error";
		},
		mode: "normal" | "cumulative" = "normal",
		modelBreakdown?: boolean,
	): Promise<AnalyticsResponse> {
		const params = new URLSearchParams({ range });

		if (filters?.accounts?.length) {
			params.append("accounts", filters.accounts.join(","));
		}
		if (filters?.models?.length) {
			params.append("models", filters.models.join(","));
		}
		if (filters?.apiKeys?.length) {
			params.append("apiKeys", filters.apiKeys.join(","));
		}
		if (filters?.status && filters.status !== "all") {
			params.append("status", filters.status);
		}
		if (mode === "cumulative") {
			params.append("mode", "cumulative");
		}
		if (modelBreakdown) {
			params.append("modelBreakdown", "true");
		}

		const queryString = params.toString();
		const url = `/api/analytics?${queryString}`;

		this.logger.info(`Fetching analytics data: ${url}`, {
			range,
			filters,
			mode,
			modelBreakdown,
			timestamp: new Date().toISOString(),
		});

		const startTime = Date.now();

		try {
			const response = await this.get<AnalyticsResponse>(url);
			const duration = Date.now() - startTime;
			this.logger.info(`Analytics data fetched successfully (${duration}ms)`, {
				dataPoints: Array.isArray(response)
					? response.length
					: "single response",
				url,
				timestamp: new Date().toISOString(),
			});
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(
				`Failed to fetch analytics data: ${error instanceof Error ? error.message : String(error)} (${duration}ms)`,
				{
					url,
					range,
					filters,
					mode,
					modelBreakdown,
					errorDetails: error,
					timestamp: new Date().toISOString(),
				},
			);

			// Log additional context for 401 errors
			if (error instanceof HttpError && error.status === 401) {
				this.logger.error(`Authentication failed for analytics request`, {
					url,
					error: error.message,
					status: error.status,
					timestamp: new Date().toISOString(),
				});
			}

			throw error;
		}
	}

	// Batch analytics requests for improved performance
	async getBatchAnalytics(
		requests: Array<{
			range?: string;
			filters?: {
				accounts?: string[];
				models?: string[];
				status?: "all" | "success" | "error";
			};
			mode?: "normal" | "cumulative";
			modelBreakdown?: boolean;
		}>,
	): Promise<AnalyticsResponse[]> {
		const startTime = Date.now();
		const url = "/api/analytics/batch";

		this.logger.debug(`→ POST ${url}`, { requestCount: requests.length });

		try {
			const response = await this.post<AnalyticsResponse[]>(url, { requests });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`, {
				responseCount: response.length,
			});
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async pauseAccount(accountId: string): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/pause`;

		this.logger.debug(`→ POST ${url}`);

		try {
			await this.post(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async resumeAccount(accountId: string): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/resume`;

		this.logger.debug(`→ POST ${url}`);

		try {
			await this.post(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async forceResetRateLimit(accountId: string): Promise<{
		success: boolean;
		message: string;
		usagePollTriggered: boolean;
	}> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/force-reset-rate-limit`;

		this.logger.debug(`→ POST ${url}`);

		try {
			const response = await this.post<{
				success: boolean;
				message: string;
				usagePollTriggered: boolean;
			}>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async refreshUsage(accountId: string): Promise<{
		success: boolean;
		message: string;
		pollingRestarted: boolean;
	}> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/refresh-usage`;

		this.logger.debug(`→ POST ${url}`);

		try {
			const response = await this.post<{
				success: boolean;
				message: string;
				pollingRestarted: boolean;
			}>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async renameAccount(
		accountId: string,
		newName: string,
	): Promise<{ newName: string }> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/rename`;

		this.logger.debug(`→ POST ${url}`, { newName });

		try {
			const response = await this.post<{
				success: boolean;
				message: string;
				newName: string;
			}>(url, { name: newName });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return { newName: response.newName };
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAccountPriority(
		accountId: string,
		priority: number,
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/priority`;

		this.logger.debug(`→ POST ${url}`, { priority });

		try {
			await this.post(url, { priority });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAccountAutoFallback(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/auto-fallback`;

		this.logger.debug(`→ POST ${url}`, { enabled });

		try {
			await this.post(url, {
				enabled: enabled ? 1 : 0,
			});
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAccountAutoRefresh(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/auto-refresh`;

		this.logger.debug(`→ POST ${url}`, { enabled });

		try {
			await this.post(url, {
				enabled: enabled ? 1 : 0,
			});
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAccountBillingType(
		accountId: string,
		billingType: "plan" | "api" | "auto",
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/billing-type`;

		this.logger.debug(`→ POST ${url}`, { billingType });

		try {
			await this.post(url, { billingType });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAccountAutoPauseOnOverage(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/auto-pause-on-overage`;

		this.logger.debug(`→ POST ${url}`, { enabled });

		try {
			await this.post(url, {
				enabled: enabled ? 1 : 0,
			});
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAccountCustomEndpoint(
		accountId: string,
		customEndpoint: string | null,
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/custom-endpoint`;

		this.logger.debug(`→ POST ${url}`, { customEndpoint });

		try {
			await this.post(url, {
				customEndpoint,
			});
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAccountModelMappings(
		accountId: string,
		modelMappings: { [key: string]: string | string[] },
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/model-mappings`;

		this.logger.debug(`→ POST ${url}`, { modelMappings });

		try {
			await this.post(url, {
				modelMappings,
			});
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAccountModelFallbacks(
		accountId: string,
		modelFallbacks: { [key: string]: string },
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/accounts/${accountId}/model-fallbacks`;

		this.logger.debug(`→ POST ${url}`, { modelFallbacks });

		try {
			await this.post(url, {
				modelFallbacks,
			});
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async getStrategy(): Promise<string> {
		const startTime = Date.now();
		const url = "/api/config/strategy";

		this.logger.debug(`→ GET ${url}`);

		try {
			const data = await this.get<{ strategy: string }>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return data.strategy;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async listStrategies(): Promise<string[]> {
		const startTime = Date.now();
		const url = "/api/strategies";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<string[]>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async setStrategy(strategy: string): Promise<void> {
		const startTime = Date.now();
		const url = "/api/config/strategy";

		this.logger.debug(`→ POST ${url}`, { strategy });

		try {
			await this.post(url, { strategy });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async getAgents(): Promise<AgentsResponse> {
		const startTime = Date.now();
		const url = "/api/agents";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<AgentsResponse>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async updateAgentPreference(agentId: string, model: string): Promise<void> {
		const startTime = Date.now();
		const url = `/api/agents/${agentId}/preference`;

		this.logger.debug(`→ POST ${url}`, { agentId, model });

		try {
			await this.post(url, { model });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async updateAgent(
		agentId: string,
		payload: AgentUpdatePayload,
	): Promise<Agent> {
		const startTime = Date.now();
		const url = `/api/agents/${agentId}`;

		this.logger.debug(`→ PATCH ${url}`, { agentId, payload });

		try {
			const response = await this.patch<{ success: boolean; agent: Agent }>(
				url,
				payload,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← PATCH ${url} - 200 (${duration}ms)`);
			return response.agent;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ PATCH ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async getDefaultAgentModel(): Promise<string> {
		const startTime = Date.now();
		const url = "/api/config/model";

		this.logger.debug(`→ GET ${url}`);

		try {
			const data = await this.get<{ model: string }>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return data.model;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async setDefaultAgentModel(model: string): Promise<void> {
		const startTime = Date.now();
		const url = "/api/config/model";

		this.logger.debug(`→ POST ${url}`, { model });

		try {
			await this.post(url, { model });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async setBulkAgentPreferences(
		model: string,
	): Promise<{ updatedCount: number }> {
		const startTime = Date.now();
		const url = "/api/agents/bulk-preference";

		this.logger.debug(`→ POST ${url}`, { model });

		try {
			const response = await this.post<{
				success: boolean;
				updatedCount: number;
				model: string;
			}>(url, { model });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return { updatedCount: response.updatedCount };
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	// Retention settings
	async getRetention(): Promise<{
		payloadDays: number;
		requestDays: number;
		storePayloads: boolean;
	}> {
		const startTime = Date.now();
		const url = "/api/config/retention";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<{
				payloadDays: number;
				requestDays: number;
				storePayloads: boolean;
			}>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async setRetention(partial: {
		payloadDays?: number;
		requestDays?: number;
		storePayloads?: boolean;
	}): Promise<void> {
		const startTime = Date.now();
		const url = "/api/config/retention";

		this.logger.debug(`→ POST ${url}`, { partial });

		try {
			await this.post(url, partial);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getCacheKeepaliveTtl(): Promise<{ ttlMinutes: number }> {
		const startTime = Date.now();
		const url = "/api/config/keepalive";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<{ ttlMinutes: number }>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async setCacheKeepaliveTtl(body: { ttlMinutes: number }): Promise<void> {
		const startTime = Date.now();
		const url = "/api/config/keepalive";

		this.logger.debug(`→ POST ${url}`, { body });

		try {
			await this.post(url, body);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getSystemCacheTtl(): Promise<{ system_prompt_cache_ttl_1h: boolean }> {
		const startTime = Date.now();
		const url = "/api/config/cache-ttl";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<{ system_prompt_cache_ttl_1h: boolean }>(
				url,
			);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async setSystemCacheTtl(enabled: boolean): Promise<void> {
		const startTime = Date.now();
		const url = "/api/config/cache-ttl";

		this.logger.debug(`→ POST ${url}`, { enabled });

		try {
			await this.post(url, { enabled });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getUsageThrottling(): Promise<{
		fiveHourEnabled: boolean;
		weeklyEnabled: boolean;
	}> {
		const startTime = Date.now();
		const url = "/api/config/usage-throttling";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<{
				fiveHourEnabled: boolean;
				weeklyEnabled: boolean;
			}>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async setUsageThrottling(settings: {
		fiveHourEnabled: boolean;
		weeklyEnabled: boolean;
	}): Promise<void> {
		const startTime = Date.now();
		const url = "/api/config/usage-throttling";

		this.logger.debug(`→ POST ${url}`, settings);

		try {
			await this.post(url, settings);
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async cleanupNow(): Promise<{
		removedRequests: number;
		removedPayloads: number;
		payloadCutoffIso: string | null;
		requestCutoffIso: string;
		dbSizeBytes: number;
		tableRowCounts: Array<{
			name: string;
			rowCount: number;
			dataBytes?: number;
		}>;
	}> {
		const startTime = Date.now();
		const url = "/api/maintenance/cleanup";

		this.logger.debug(`→ POST ${url}`);

		try {
			const response = await this.post<{
				removedRequests: number;
				removedPayloads: number;
				payloadCutoffIso: string | null;
				requestCutoffIso: string;
				dbSizeBytes: number;
				tableRowCounts: Array<{
					name: string;
					rowCount: number;
					dataBytes?: number;
				}>;
			}>(url, undefined, { timeout: 10 * 60 * 1000 });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async compactDb(): Promise<{
		ok: boolean;
		error?: string;
		walCheckpointed?: number;
		walBusy?: number;
		walLog?: number;
		walTruncateBusy?: number;
		vacuumed?: boolean;
	}> {
		const startTime = Date.now();
		const url = "/api/maintenance/compact";

		this.logger.debug(`→ POST ${url}`);

		try {
			const response = await this.post<{
				ok: boolean;
				error?: string;
				walCheckpointed?: number;
				walBusy?: number;
				walLog?: number;
				walTruncateBusy?: number;
				vacuumed?: boolean;
			}>(url, undefined, { timeout: 10 * 60 * 1000 });
			const duration = Date.now() - startTime;
			this.logger.debug(`← POST ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ POST ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	// Helper method for token health API calls to reduce code duplication
	private async tokenHealthRequest<T>(
		url: string,
		_description: string,
	): Promise<T> {
		const startTime = Date.now();

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<T>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	async getTokenHealth(): Promise<TokenHealthGlobalResponse> {
		const url = "/api/token-health";
		return this.tokenHealthRequest<TokenHealthGlobalResponse>(
			url,
			"token health",
		);
	}

	async getReauthNeeded(): Promise<ReauthNeededResponse> {
		const url = "/api/token-health/reauth-needed";
		return this.tokenHealthRequest<ReauthNeededResponse>(url, "reauth needed");
	}

	async getAccountTokenHealth(
		accountName: string,
	): Promise<TokenHealthAccountResponse> {
		const url = `/api/token-health/account/${accountName}`;
		return this.tokenHealthRequest<TokenHealthAccountResponse>(
			url,
			"account token health",
		);
	}

	async updateApiKeyRole(
		keyId: string,
		role: "admin" | "api-only",
	): Promise<void> {
		const startTime = Date.now();
		const url = `/api/api-keys/${encodeURIComponent(keyId)}/role`;

		this.logger.debug(`→ PATCH ${url}`, { role });

		try {
			await this.patch(url, { role });
			const duration = Date.now() - startTime;
			this.logger.debug(`← PATCH ${url} - 200 (${duration}ms)`);
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ PATCH ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async getCombos(): Promise<{ combos: (Combo & { slot_count: number })[] }> {
		const res = await this.get<{
			success: boolean;
			data: (Combo & { slot_count: number })[];
		}>("/api/combos");
		return { combos: res.data };
	}

	async deleteCombo(id: string): Promise<void> {
		await this.delete(`/api/combos/${id}`);
	}

	async updateCombo(
		id: string,
		params: { name?: string; description?: string; enabled?: boolean },
	): Promise<{ combo: Combo }> {
		const res = await this.put<{ success: boolean; data: Combo }>(
			`/api/combos/${id}`,
			params,
		);
		return { combo: res.data };
	}

	async createCombo(params: {
		name: string;
		description?: string;
		enabled?: boolean;
	}): Promise<{ combo: Combo }> {
		const res = await this.post<{ success: boolean; data: Combo }>(
			"/api/combos",
			params,
		);
		return { combo: res.data };
	}

	async getFamilies(): Promise<{ families: ComboFamilyAssignment[] }> {
		const res = await this.get<{
			success: boolean;
			data: ComboFamilyAssignment[];
		}>("/api/families");
		return { families: res.data.map((f) => ({ ...f, enabled: !!f.enabled })) };
	}

	async assignFamily(params: {
		family: string;
		comboId: string | null;
		enabled: boolean;
	}): Promise<void> {
		await this.put(`/api/families/${params.family}`, {
			combo_id: params.comboId,
			enabled: params.enabled,
		});
	}

	async getCombo(id: string): Promise<{ combo: ComboWithSlots }> {
		const res = await this.get<{ success: boolean; data: ComboWithSlots }>(
			`/api/combos/${id}`,
		);
		return { combo: res.data };
	}

	async addComboSlot(
		comboId: string,
		params: { account_id: string; model: string; enabled?: boolean },
	): Promise<{ slot: ComboSlot }> {
		const res = await this.post<{ success: boolean; data: ComboSlot }>(
			`/api/combos/${comboId}/slots`,
			params,
		);
		return { slot: res.data };
	}

	async updateComboSlot(
		comboId: string,
		slotId: string,
		params: { model?: string; enabled?: boolean },
	): Promise<{ slot: ComboSlot }> {
		const res = await this.put<{ success: boolean; data: ComboSlot }>(
			`/api/combos/${comboId}/slots/${slotId}`,
			params,
		);
		return { slot: res.data };
	}

	async removeComboSlot(comboId: string, slotId: string): Promise<void> {
		await this.delete(`/api/combos/${comboId}/slots/${slotId}`);
	}

	async reorderComboSlots(comboId: string, slotIds: string[]): Promise<void> {
		await this.put(`/api/combos/${comboId}/slots/reorder`, { slotIds });
	}

	async initCodexDeviceFlow(data: { name: string; priority: number }): Promise<{
		sessionId: string;
		verificationUrl: string;
		userCode: string;
	}> {
		const url = "/api/oauth/codex/init";
		this.logger.debug(`→ POST ${url}`, { data });
		try {
			const response = await this.post<{
				sessionId: string;
				verificationUrl: string;
				userCode: string;
			}>(url, data);
			this.logger.debug(`← POST ${url} - 200`);
			return response;
		} catch (error) {
			this.logger.error(`✗ POST ${url} - ERROR`, { error });
			if (error instanceof HttpError) throw new Error(error.message);
			throw error;
		}
	}

	async getCodexAuthStatus(
		sessionId: string,
	): Promise<{ status: "pending" | "complete" | "error"; error?: string }> {
		const url = `/api/oauth/codex/status/${sessionId}`;
		this.logger.debug(`→ GET ${url}`);
		try {
			const response = await this.get<{
				status: "pending" | "complete" | "error";
				error?: string;
			}>(url);
			this.logger.debug(`← GET ${url} - 200`);
			return response;
		} catch (error) {
			this.logger.error(`✗ GET ${url} - ERROR`, { error });
			if (error instanceof HttpError) throw new Error(error.message);
			throw error;
		}
	}

	async initQwenDeviceFlow(data: {
		name: string;
		priority: number;
	}): Promise<{ sessionId: string; authUrl: string; userCode: string }> {
		const url = "/api/oauth/qwen/init";
		this.logger.debug(`→ POST ${url}`, { data });
		try {
			const response = await this.post<{
				sessionId: string;
				authUrl: string;
				userCode: string;
			}>(url, data);
			this.logger.debug(`← POST ${url} - 200`);
			return response;
		} catch (error) {
			this.logger.error(`✗ POST ${url} - ERROR`, { error });
			if (error instanceof HttpError) throw new Error(error.message);
			throw error;
		}
	}

	async initQwenReauth(data: {
		accountId: string;
	}): Promise<{ sessionId: string; authUrl: string; userCode: string }> {
		const url = "/api/oauth/qwen/reauth";
		this.logger.debug(`→ POST ${url}`, { data });
		try {
			const response = await this.post<{
				sessionId: string;
				authUrl: string;
				userCode: string;
			}>(url, data);
			this.logger.debug(`← POST ${url} - 200`);
			return response;
		} catch (error) {
			this.logger.error(`✗ POST ${url} - ERROR`, { error });
			if (error instanceof HttpError) throw new Error(error.message);
			throw error;
		}
	}

	async initCodexReauth(data: { accountId: string }): Promise<{
		sessionId: string;
		verificationUrl: string;
		userCode: string;
	}> {
		const url = "/api/oauth/codex/reauth";
		this.logger.debug(`→ POST ${url}`, { data });
		try {
			const response = await this.post<{
				sessionId: string;
				verificationUrl: string;
				userCode: string;
			}>(url, data);
			this.logger.debug(`← POST ${url} - 200`);
			return response;
		} catch (error) {
			this.logger.error(`✗ POST ${url} - ERROR`, { error });
			if (error instanceof HttpError) throw new Error(error.message);
			throw error;
		}
	}

	async initAnthropicReauth(
		accountId: string,
	): Promise<{ authUrl: string; sessionId: string }> {
		const url = "/api/oauth/anthropic/reauth/init";
		this.logger.debug(`→ POST ${url}`, { accountId });
		try {
			const response = await this.post<{ authUrl: string; sessionId: string }>(
				url,
				{ accountId },
			);
			this.logger.debug(`← POST ${url} - 200`);
			return response;
		} catch (error) {
			this.logger.error(`✗ POST ${url} - ERROR`, { error });
			if (error instanceof HttpError) throw new Error(error.message);
			throw error;
		}
	}

	async completeAnthropicReauth(
		sessionId: string,
		code: string,
	): Promise<{ success: boolean; message: string }> {
		const url = "/api/oauth/anthropic/reauth/callback";
		this.logger.debug(`→ POST ${url}`, { sessionId });
		try {
			const response = await this.post<{ success: boolean; message: string }>(
				url,
				{ sessionId, code },
			);
			this.logger.debug(`← POST ${url} - 200`);
			return response;
		} catch (error) {
			this.logger.error(`✗ POST ${url} - ERROR`, { error });
			if (error instanceof HttpError) throw new Error(error.message);
			throw error;
		}
	}

	async updateAccountPeakHoursPause(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.post(`/api/accounts/${accountId}/peak-hours-pause`, {
			enabled: enabled ? 1 : 0,
		});
	}

	async getQwenAuthStatus(
		sessionId: string,
	): Promise<{ status: "pending" | "complete" | "error"; error?: string }> {
		const url = `/api/oauth/qwen/status/${sessionId}`;
		this.logger.debug(`→ GET ${url}`);
		try {
			const response = await this.get<{
				status: "pending" | "complete" | "error";
				error?: string;
			}>(url);
			this.logger.debug(`← GET ${url} - 200`);
			return response;
		} catch (error) {
			this.logger.error(`✗ GET ${url} - ERROR`, { error });
			if (error instanceof HttpError) throw new Error(error.message);
			throw error;
		}
	}

	async getFeatures(): Promise<{ showCombos: boolean }> {
		const startTime = Date.now();
		const url = "/api/features";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<{
				success: boolean;
				data: { showCombos: boolean };
			}>(url);
			const duration = Date.now() - startTime;
			this.logger.debug(`← GET ${url} - 200 (${duration}ms)`);
			return response.data;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`✗ GET ${url} - ERROR (${duration}ms)`, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}
}

export const api = new API();
