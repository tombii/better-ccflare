import { HttpClient, HttpError } from "@better-ccflare/http-common";
import type {
	AccountResponse,
	Agent,
	AgentUpdatePayload,
	AgentWorkspace,
	AnalyticsResponse,
	LogEvent,
	RequestPayload,
	RequestResponse,
	StatsWithAccounts,
} from "@better-ccflare/types";
import { API_LIMITS, API_TIMEOUT } from "./constants";

// Re-export types with dashboard-specific aliases for backward compatibility
export type Account = AccountResponse;
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
	workspaces: AgentWorkspace[];
}

class API extends HttpClient {
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

	async getStats(): Promise<Stats> {
		const startTime = Date.now();
		const url = "/api/stats";

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
			| "nanogpt"
			| "anthropic-compatible"
			| "openai-compatible";
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

	async addNanoGPTAccount(data: {
		name: string;
		apiKey: string;
		priority: number;
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
		modelMappings: { [key: string]: string },
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
	async getRetention(): Promise<{ payloadDays: number; requestDays: number }> {
		const startTime = Date.now();
		const url = "/api/config/retention";

		this.logger.debug(`→ GET ${url}`);

		try {
			const response = await this.get<{
				payloadDays: number;
				requestDays: number;
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

	async cleanupNow(): Promise<{
		removedRequests: number;
		removedPayloads: number;
		cutoffIso: string;
	}> {
		const startTime = Date.now();
		const url = "/api/maintenance/cleanup";

		this.logger.debug(`→ POST ${url}`);

		try {
			const response = await this.post<{
				removedRequests: number;
				removedPayloads: number;
				cutoffIso: string;
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

	async compactDb(): Promise<{ ok: boolean }> {
		const startTime = Date.now();
		const url = "/api/maintenance/compact";

		this.logger.debug(`→ POST ${url}`);

		try {
			const response = await this.post<{ ok: boolean }>(url);
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
}

export const api = new API();
