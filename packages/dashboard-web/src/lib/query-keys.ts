export const queryKeys = {
	all: ["better-ccflare"] as const,
	accounts: () => [...queryKeys.all, "accounts"] as const,
	agents: () => [...queryKeys.all, "agents"] as const,
	stats: (errorsSinceHours?: number) =>
		errorsSinceHours !== undefined
			? ([...queryKeys.all, "stats", { errorsSinceHours }] as const)
			: ([...queryKeys.all, "stats"] as const),
	analytics: (
		timeRange?: string,
		filters?: unknown,
		viewMode?: string,
		modelBreakdown?: boolean,
	) =>
		[
			...queryKeys.all,
			"analytics",
			{ timeRange, filters, viewMode, modelBreakdown },
		] as const,
	insightsCache: (timeRange?: string, threshold?: number) =>
		[...queryKeys.all, "insights", "cache", { timeRange, threshold }] as const,
	insightsContext: (timeRange?: string) =>
		[...queryKeys.all, "insights", "context", { timeRange }] as const,
	insightsAnomalies: (timeRange?: string) =>
		[...queryKeys.all, "insights", "anomalies", { timeRange }] as const,
	insightsAlerts: () => [...queryKeys.all, "insights", "alerts"] as const,
	requests: (limit?: number) =>
		[...queryKeys.all, "requests", { limit }] as const,
	logs: () => [...queryKeys.all, "logs"] as const,
	logHistory: () => [...queryKeys.all, "logs", "history"] as const,
	defaultAgentModel: () =>
		[...queryKeys.all, "config", "defaultAgentModel"] as const,
	combos: () => [...queryKeys.all, "combos"] as const,
	families: () => [...queryKeys.all, "families"] as const,
	apiKeys: () => [...queryKeys.all, "api-keys"] as const,
	storage: () => [...queryKeys.all, "storage"] as const,
	usageHistory: (account?: string, range?: string) =>
		[...queryKeys.all, "usage-history", { account, range }] as const,
	models: () => [...queryKeys.all, "models"] as const,
	// Deliberately kept under the 'models' key: invalidating models() also
	// invalidates the per-provider lists.
	// The account is part of the key: two accounts of the same provider can be
	// on different plans and get different lists.
	providerModels: (provider?: string | null, accountId?: string | null) =>
		[
			...queryKeys.all,
			"models",
			"provider",
			provider ?? "",
			accountId ?? "",
		] as const,
	// Single record for the default-model map per provider+family (today the
	// last word in the chain, hardcoded). No parameter: the screen reads
	// and writes everything at once.
	providerModelDefaults: () =>
		[...queryKeys.all, "config", "provider-model-defaults"] as const,
	// One key per on/off config setting, named by its endpoint path so two
	// settings can never share a cache entry.
	configFlag: (path: string) =>
		[...queryKeys.all, "config", "flag", path] as const,
} as const;
