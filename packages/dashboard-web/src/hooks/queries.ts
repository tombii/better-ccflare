import type { AgentUpdatePayload } from "@better-ccflare/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../lib/query-keys";

export const useAccounts = () => {
	return useQuery({
		queryKey: queryKeys.accounts(),
		queryFn: () => api.getAccounts(),
		staleTime: 20000, // Consider data fresh for 20 seconds
		refetchInterval: 60000, // Refresh every minute for usage data
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
	});
};

export const useAgents = () => {
	return useQuery({
		queryKey: queryKeys.agents(),
		queryFn: () => api.getAgents(),
		staleTime: 60000, // Consider data fresh for 1 minute
		refetchInterval: 60000, // Increase from 30 to 60 seconds
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
	});
};

export const useStats = (refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.stats(),
		queryFn: () => api.getStats(),
		staleTime: 15000, // Consider data fresh for 15 seconds
		refetchInterval: refetchInterval ?? 30000, // Default to 30 seconds instead of 10
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
	});
};

export const useAnalytics = (
	timeRange: string,
	filters: {
		accounts?: string[];
		models?: string[];
		apiKeys?: string[];
		status?: "all" | "success" | "error";
	},
	viewMode: "normal" | "cumulative",
	modelBreakdown?: boolean,
) => {
	const logger = {
		debug: (message: string, ...args: unknown[]) => {
			console.debug(`[Analytics Query] ${message}`, ...args);
		},
		error: (message: string, ...args: unknown[]) => {
			console.error(`[Analytics Query] ${message}`, ...args);
		},
	};

	return useQuery({
		queryKey: queryKeys.analytics(timeRange, filters, viewMode, modelBreakdown),
		queryFn: async () => {
			logger.debug(`Starting analytics query`, {
				timeRange,
				filters,
				viewMode,
				modelBreakdown,
				timestamp: new Date().toISOString(),
			});

			try {
				const result = await api.getAnalytics(
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
				);
				logger.debug(`Analytics query completed successfully`, {
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
					resultType: Array.isArray(result) ? "array" : "object",
					timestamp: new Date().toISOString(),
				});
				return result;
			} catch (error) {
				logger.error(`Analytics query failed`, {
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
					error: error instanceof Error ? error.message : String(error),
					errorStack: error instanceof Error ? error.stack : undefined,
					timestamp: new Date().toISOString(),
				});
				throw error;
			}
		},
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 15 * 60 * 1000,
		enabled: !!timeRange,
		retry: (failureCount, error) => {
			logger.debug(`Analytics query retry attempt ${failureCount + 1}`, {
				error: error instanceof Error ? error.message : String(error),
				willRetry: failureCount < 3, // Retry up to 3 times
				timestamp: new Date().toISOString(),
			});
			return failureCount < 3;
		},
	});
};

export const useRequests = (limit: number, _refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.requests(limit),
		queryFn: async () => {
			const [requestsDetail, requestsSummary] = await Promise.all([
				api.getRequestsDetail(limit),
				api.getRequestsSummary(limit),
			]);
			// Convert array to Map for detailsMap
			const detailsMap = new Map(
				requestsSummary.map((summary) => [summary.id, summary]),
			);
			return { requests: requestsDetail, detailsMap };
		},
		staleTime: Infinity, // Consider data fresh until manually refetched
		gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
		// Remove refetchInterval - SSE stream handles real-time updates
	});
};

export const useLogHistory = () => {
	return useQuery({
		queryKey: queryKeys.logHistory(),
		queryFn: () => api.getLogHistory(),
	});
};

// Mutations
export const useRemoveAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			name,
			confirmInput,
		}: {
			name: string;
			confirmInput: string;
		}) => api.removeAccount(name, confirmInput),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useRenameAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			accountId,
			newName,
		}: {
			accountId: string;
			newName: string;
		}) => api.renameAccount(accountId, newName),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useResetStats = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.resetStats(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.stats() });
		},
	});
};

export const useUpdateAgentPreference = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ agentId, model }: { agentId: string; model: string }) =>
			api.updateAgentPreference(agentId, model),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
		},
	});
};

export const useDefaultAgentModel = () => {
	return useQuery({
		queryKey: queryKeys.defaultAgentModel(),
		queryFn: () => api.getDefaultAgentModel(),
		staleTime: 2 * 60 * 1000, // Consider data fresh for 2 minutes
		refetchInterval: 5 * 60 * 1000, // Poll every 5 minutes instead of 1
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
	});
};

export const useSetDefaultAgentModel = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (model: string) => api.setDefaultAgentModel(model),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.defaultAgentModel(),
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
		},
	});
};

export const useBulkUpdateAgentPreferences = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (model: string) => api.setBulkAgentPreferences(model),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
		},
	});
};

export const useUpdateAgent = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			payload,
		}: {
			id: string;
			payload: AgentUpdatePayload;
		}) => api.updateAgent(id, payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
		},
	});
};

// Note: Clear logs functionality appears to be removed from the API

// Retention settings
export const useRetention = () => {
	return useQuery({
		queryKey: ["retention"],
		queryFn: () => api.getRetention(),
	});
};

export const useSetRetention = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (partial: { payloadDays?: number; requestDays?: number }) =>
			api.setRetention(partial),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["retention"] });
		},
	});
};

export const useCleanupNow = () => {
	return useMutation({
		mutationFn: () => api.cleanupNow(),
	});
};

export const useCompactDb = () => {
	return useMutation({
		mutationFn: () => api.compactDb(),
	});
};
