import {
	formatCost,
	formatDuration,
	formatTokens,
	formatTokensPerSecond,
} from "@better-ccflare/ui-common";
import {
	Bot,
	Calendar,
	ChevronDown,
	ChevronRight,
	Clock,
	Eye,
	Filter,
	Hash,
	Key,
	RefreshCw,
	User,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { API_LIMITS } from "../constants";
import { useAccounts, useApiKeys, useRequests } from "../hooks/queries";
import { useRequestStream } from "../hooks/useRequestStream";
import { isAnthropicPeakHour, isZaiPeakHour } from "../utils/provider-utils";
import { CopyButton } from "./CopyButton";
import { RequestDetailsModal } from "./RequestDetailsModal";
import { TokenUsageDisplay } from "./TokenUsageDisplay";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";

export function RequestsTab() {
	const [expandedRequests, setExpandedRequests] = useState<Set<string>>(
		new Set(),
	);
	const [modalRequest, setModalRequest] = useState<RequestPayload | null>(null);
	const [accountFilter, setAccountFilter] = useState<string>("all");
	const [agentFilter, setAgentFilter] = useState<string>("all");
	const [apiKeyFilter, setApiKeyFilter] = useState<string>("all");
	const [dateFrom, setDateFrom] = useState<string>("");
	const [dateTo, setDateTo] = useState<string>("");
	const [showFilters, setShowFilters] = useState(false);
	const [statusCodeFilters, setStatusCodeFilters] = useState<Set<string>>(
		new Set(),
	);

	const {
		data: requestsData,
		isLoading: loading,
		error,
		refetch: loadRequests,
	} = useRequests(API_LIMITS.requestsDetail);

	// Enable real-time updates
	useRequestStream(API_LIMITS.requestsDetail);

	const { data: accounts } = useAccounts();
	const { data: configuredApiKeys } = useApiKeys();
	const zaiAccountNames = new Set(
		(accounts ?? []).filter((a) => a.provider === "zai").map((a) => a.name),
	);
	const oauthAccountNames = new Set(
		(accounts ?? [])
			.filter((a) => a.provider === "anthropic")
			.map((a) => a.name),
	);

	// Transform the data to match the expected structure - memoized to avoid recalculation on SSE updates
	const data = useMemo(() => {
		if (!requestsData) return null;
		return {
			requests: requestsData.requests,
			summaries:
				requestsData.detailsMap instanceof Map
					? (requestsData.detailsMap as Map<string, RequestSummary>)
					: new Map<string, RequestSummary>(
							Array.isArray(requestsData.detailsMap)
								? (requestsData.detailsMap as RequestSummary[]).map(
										(s) => [s.id, s] as [string, RequestSummary],
									)
								: [],
						),
		};
	}, [requestsData]);

	// Filter dropdown options come from dedicated endpoints (not from the loaded
	// requests slice) so every configured account/API key is selectable, even
	// when it doesn't appear in the most recent N requests.
	const uniqueAccounts = useMemo(() => {
		const fromConfig = (accounts ?? []).map((a) => a.name).filter(Boolean);
		const fromRequests = (data?.requests ?? [])
			.map((r) => r.meta.accountName || r.meta.accountId)
			.filter((v): v is string => Boolean(v));
		return Array.from(new Set([...fromConfig, ...fromRequests])).sort();
	}, [accounts, data]);

	// Extract unique status codes for filter - memoized
	const uniqueStatusCodes = useMemo(() => {
		if (!data) return [];
		return Array.from(
			new Set(
				data.requests
					.map((r) => r.response?.status)
					.filter((status): status is number => status !== undefined),
			),
		).sort((a, b) => a - b);
	}, [data]);

	// Extract unique agents for filter - memoized
	const uniqueAgents = useMemo(() => {
		if (!data) return [];
		return Array.from(
			new Set(
				data.requests
					.map((r) => {
						const summary = data.summaries.get(r.id);
						return summary?.agentUsed || r.meta.agentUsed;
					})
					.filter(Boolean),
			),
		).sort();
	}, [data]);

	// API key filter: union of all configured keys (from /api/api-keys) and any
	// keys observed in the loaded request slice (covers historical keys that
	// were deleted but still appear on past requests).
	const uniqueApiKeys = useMemo(() => {
		const fromConfig = (configuredApiKeys ?? []).map((k) => k.name);
		const fromRequests = data
			? Array.from(data.summaries.values())
					.map((s) => s.apiKeyName)
					.filter((v): v is string => Boolean(v))
			: [];
		return Array.from(new Set([...fromConfig, ...fromRequests])).sort();
	}, [configuredApiKeys, data]);

	// Filter requests based on selected filters - memoized to avoid recalculation on every render
	const filteredRequests = useMemo(() => {
		if (!data) return [];
		return data.requests.filter((request) => {
			// Account filter
			if (accountFilter !== "all") {
				const requestAccount =
					request.meta.accountName || request.meta.accountId;
				if (requestAccount !== accountFilter) return false;
			}

			// Agent filter
			if (agentFilter !== "all") {
				const summary = data.summaries.get(request.id);
				const requestAgent = summary?.agentUsed || request.meta.agentUsed;
				if (requestAgent !== agentFilter) return false;
			}

			// API key filter
			if (apiKeyFilter !== "all") {
				const summary = data.summaries.get(request.id);
				const requestApiKey = summary?.apiKeyName;
				if (apiKeyFilter === "no-api-key") {
					if (requestApiKey) return false;
				} else {
					if (requestApiKey !== apiKeyFilter) return false;
				}
			}

			// Status code filter
			if (statusCodeFilters.size > 0 && request.response?.status) {
				if (!statusCodeFilters.has(request.response.status.toString())) {
					return false;
				}
			}

			// Date range filter
			const requestDate = new Date(request.meta.timestamp);
			if (dateFrom) {
				const fromDate = new Date(dateFrom);
				fromDate.setHours(0, 0, 0, 0);
				if (requestDate < fromDate) return false;
			}
			if (dateTo) {
				const toDate = new Date(dateTo);
				toDate.setHours(23, 59, 59, 999);
				if (requestDate > toDate) return false;
			}

			return true;
		});
	}, [
		data,
		accountFilter,
		agentFilter,
		apiKeyFilter,
		statusCodeFilters,
		dateFrom,
		dateTo,
	]);

	const toggleExpanded = (id: string) => {
		setExpandedRequests((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	// Date preset helpers
	const applyDatePreset = (preset: string) => {
		const now = new Date();
		const toDate = now.toISOString().slice(0, 16);

		switch (preset) {
			case "1h": {
				const fromDate = new Date(now.getTime() - 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				setDateTo(toDate);
				break;
			}
			case "24h": {
				const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				setDateTo(toDate);
				break;
			}
			case "7d": {
				const fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				setDateTo(toDate);
				break;
			}
			case "30d": {
				const fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				setDateTo(toDate);
				break;
			}
		}
	};

	const toggleStatusCode = (code: string) => {
		setStatusCodeFilters((prev) => {
			const next = new Set(prev);
			if (next.has(code)) {
				next.delete(code);
			} else {
				next.add(code);
			}
			return next;
		});
	};

	const getStatusCodeColor = (code: number) => {
		if (code >= 200 && code < 300) return "text-green-600";
		if (code >= 400 && code < 500) return "text-yellow-600";
		if (code >= 500) return "text-red-600";
		return "text-gray-600";
	};

	const clearAllFilters = () => {
		setAccountFilter("all");
		setAgentFilter("all");
		setApiKeyFilter("all");
		setDateFrom("");
		setDateTo("");
		setStatusCodeFilters(new Set());
	};

	const hasActiveFilters =
		accountFilter !== "all" ||
		agentFilter !== "all" ||
		apiKeyFilter !== "all" ||
		dateFrom ||
		dateTo ||
		statusCodeFilters.size > 0;

	const decodeBase64 = (str: string | null): string => {
		if (!str) return "No data";
		try {
			// Handle edge cases like "[streamed]" from older data
			if (str === "[streamed]") {
				return "[Streaming data not captured]";
			}
			return atob(str);
		} catch (error) {
			console.error("Failed to decode base64:", error, "Input:", str);
			return `Failed to decode: ${str}`;
		}
	};

	/**
	 * Copy the given request to the clipboard as pretty-printed JSON, with
	 * any base64-encoded bodies already decoded for easier debugging.
	 */
	// copyRequest helper removed – handled inline by CopyButton

	if (loading) {
		return (
			<Card>
				<CardContent className="pt-6">
					<p className="text-muted-foreground">Loading requests...</p>
				</CardContent>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<CardContent className="pt-6">
					<p className="text-destructive">
						Error: {error instanceof Error ? error.message : String(error)}
					</p>
					<Button
						onClick={() => loadRequests()}
						variant="outline"
						size="sm"
						className="mt-2"
					>
						<RefreshCw className="mr-2 h-4 w-4" />
						Retry
					</Button>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Request History</CardTitle>
						<CardDescription>
							Detailed request and response data (last{" "}
							{API_LIMITS.requestsDetail})
						</CardDescription>
					</div>
					<div className="flex gap-2">
						<Button
							onClick={() => setShowFilters(!showFilters)}
							variant={showFilters ? "default" : "outline"}
							size="sm"
							className="relative"
						>
							<Filter className="h-4 w-4 mr-2" />
							Filters
							{hasActiveFilters && !showFilters && (
								<span className="absolute -top-1 -right-1 h-2 w-2 bg-primary rounded-full animate-pulse" />
							)}
						</Button>
						<Button onClick={() => loadRequests()} variant="ghost" size="icon">
							<RefreshCw className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{/* Active Filters Display */}
				{hasActiveFilters && (
					<div className="mb-4 p-3 bg-muted/50 rounded-lg">
						<div className="flex flex-wrap items-center gap-2">
							{accountFilter !== "all" && (
								<Badge variant="outline" className="gap-1.5 pr-1">
									<User className="h-3 w-3" />
									{accountFilter}
									<button
										type="button"
										onClick={() => setAccountFilter("all")}
										className="ml-1 p-0.5 hover:bg-destructive/20 rounded"
									>
										<X className="h-3 w-3" />
									</button>
								</Badge>
							)}
							{agentFilter !== "all" && (
								<Badge variant="outline" className="gap-1.5 pr-1">
									<Bot className="h-3 w-3" />
									{agentFilter}
									<button
										type="button"
										onClick={() => setAgentFilter("all")}
										className="ml-1 p-0.5 hover:bg-destructive/20 rounded"
									>
										<X className="h-3 w-3" />
									</button>
								</Badge>
							)}
							{apiKeyFilter !== "all" && (
								<Badge variant="outline" className="gap-1.5 pr-1">
									<Hash className="h-3 w-3" />
									{apiKeyFilter === "no-api-key" ? "No API Key" : apiKeyFilter}
									<button
										type="button"
										onClick={() => setApiKeyFilter("all")}
										className="ml-1 p-0.5 hover:bg-destructive/20 rounded"
									>
										<X className="h-3 w-3" />
									</button>
								</Badge>
							)}
							{statusCodeFilters.size > 0 && (
								<Badge variant="outline" className="gap-1.5 pr-1">
									<Hash className="h-3 w-3" />
									{Array.from(statusCodeFilters).join(", ")}
									<button
										type="button"
										onClick={() => setStatusCodeFilters(new Set())}
										className="ml-1 p-0.5 hover:bg-destructive/20 rounded"
									>
										<X className="h-3 w-3" />
									</button>
								</Badge>
							)}
							{(dateFrom || dateTo) && (
								<Badge variant="outline" className="gap-1.5 pr-1">
									<Calendar className="h-3 w-3" />
									{dateFrom && dateTo
										? "Custom range"
										: dateFrom
											? `From ${new Date(dateFrom).toLocaleDateString()}`
											: `Until ${new Date(dateTo).toLocaleDateString()}`}
									<button
										type="button"
										onClick={() => {
											setDateFrom("");
											setDateTo("");
										}}
										className="ml-1 p-0.5 hover:bg-destructive/20 rounded"
									>
										<X className="h-3 w-3" />
									</button>
								</Badge>
							)}
							<div className="ml-auto flex items-center gap-2">
								<span className="text-xs text-muted-foreground">
									{filteredRequests.length} of {data?.requests.length || 0}{" "}
									requests
								</span>
								<Button
									variant="ghost"
									size="sm"
									onClick={clearAllFilters}
									className="h-7 text-xs"
								>
									Clear all
								</Button>
							</div>
						</div>
					</div>
				)}

				{/* Filters Panel */}
				{showFilters && (
					<div className="mb-6 border rounded-lg bg-card">
						<div className="p-4 border-b">
							<div className="flex items-center justify-between">
								<h3 className="font-medium">Filters</h3>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setShowFilters(false)}
									className="h-8 w-8 p-0"
								>
									<X className="h-4 w-4" />
								</Button>
							</div>
						</div>

						<div className="p-4 space-y-4">
							{/* Time Range Section */}
							<div>
								<h4 className="text-sm font-medium mb-3 flex items-center gap-2">
									<Clock className="h-4 w-4" />
									Time Range
								</h4>
								<div className="flex flex-wrap gap-2 mb-3">
									<Button
										variant={dateFrom || dateTo ? "outline" : "secondary"}
										size="sm"
										onClick={() => applyDatePreset("1h")}
									>
										Last hour
									</Button>
									<Button
										variant={dateFrom || dateTo ? "outline" : "secondary"}
										size="sm"
										onClick={() => applyDatePreset("24h")}
									>
										Last 24h
									</Button>
									<Button
										variant={dateFrom || dateTo ? "outline" : "secondary"}
										size="sm"
										onClick={() => applyDatePreset("7d")}
									>
										Last 7 days
									</Button>
									<Button
										variant={dateFrom || dateTo ? "outline" : "secondary"}
										size="sm"
										onClick={() => applyDatePreset("30d")}
									>
										Last 30 days
									</Button>
								</div>
								<div className="grid grid-cols-2 gap-3">
									<div>
										<Label htmlFor="date-from" className="text-xs">
											From
										</Label>
										<Input
											id="date-from"
											type="datetime-local"
											value={dateFrom}
											onChange={(e) => setDateFrom(e.target.value)}
											className="h-9 text-sm"
										/>
									</div>
									<div>
										<Label htmlFor="date-to" className="text-xs">
											To
										</Label>
										<Input
											id="date-to"
											type="datetime-local"
											value={dateTo}
											onChange={(e) => setDateTo(e.target.value)}
											className="h-9 text-sm"
										/>
									</div>
								</div>
							</div>

							<div className="h-px bg-border" />

							{/* Resource Filters */}
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
								{/* Account Filter */}
								<div>
									<Label className="text-xs flex items-center gap-1 mb-2">
										<User className="h-3 w-3" />
										Account
									</Label>
									<Select
										value={accountFilter}
										onValueChange={setAccountFilter}
									>
										<SelectTrigger className="h-9">
											<SelectValue placeholder="All accounts" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">All accounts</SelectItem>
											{uniqueAccounts.map((account) => (
												<SelectItem key={account} value={account || ""}>
													{account}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								{/* Agent Filter */}
								<div>
									<Label className="text-xs flex items-center gap-1 mb-2">
										<Bot className="h-3 w-3" />
										Agent
									</Label>
									<Select value={agentFilter} onValueChange={setAgentFilter}>
										<SelectTrigger className="h-9">
											<SelectValue placeholder="All agents" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">All agents</SelectItem>
											{uniqueAgents.map((agent) => (
												<SelectItem key={agent} value={agent || ""}>
													{agent}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								{/* API Key Filter */}
								<div>
									<Label className="text-xs flex items-center gap-1 mb-2">
										<Key className="h-3 w-3" />
										API Key
									</Label>
									<Select value={apiKeyFilter} onValueChange={setApiKeyFilter}>
										<SelectTrigger className="h-9">
											<SelectValue placeholder="All API keys" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">All API keys</SelectItem>
											<SelectItem value="no-api-key">No API Key</SelectItem>
											{uniqueApiKeys.map((key) => (
												<SelectItem key={key} value={key || ""}>
													{key}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								{/* Status Code Filter */}
								<div>
									<Label className="text-xs flex items-center gap-1 mb-2">
										<Hash className="h-3 w-3" />
										Status Code
									</Label>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="outline"
												className="h-9 w-full justify-between font-normal"
											>
												{statusCodeFilters.size > 0
													? `${statusCodeFilters.size} selected`
													: "All codes"}
												<ChevronDown className="h-4 w-4 opacity-50" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent className="w-56 max-h-64 overflow-y-auto">
											<div className="p-2">
												<div className="text-xs font-medium text-muted-foreground mb-2">
													Select status codes
												</div>
												{uniqueStatusCodes.map((code) => (
													<button
														key={code}
														type="button"
														className="flex items-center gap-2 p-2 hover:bg-accent rounded cursor-pointer w-full text-left"
														onClick={() => toggleStatusCode(code.toString())}
													>
														<div
															className={`w-4 h-4 border rounded-sm flex items-center justify-center ${
																statusCodeFilters.has(code.toString())
																	? "bg-primary border-primary"
																	: "border-input"
															}`}
														>
															{statusCodeFilters.has(code.toString()) && (
																<svg
																	className="w-3 h-3 text-primary-foreground"
																	fill="none"
																	viewBox="0 0 24 24"
																	stroke="currentColor"
																	aria-label="Selected"
																>
																	<title>Selected</title>
																	<path
																		strokeLinecap="round"
																		strokeLinejoin="round"
																		strokeWidth={3}
																		d="M5 13l4 4L19 7"
																	/>
																</svg>
															)}
														</div>
														<span
															className={`text-sm font-medium ${getStatusCodeColor(code)}`}
														>
															{code}
														</span>
													</button>
												))}
											</div>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>
						</div>
					</div>
				)}

				{!data ? (
					<p className="text-muted-foreground">No requests found</p>
				) : filteredRequests.length === 0 ? (
					<p className="text-muted-foreground">
						No requests match the selected filters
					</p>
				) : (
					<div className="space-y-2">
						{filteredRequests.map((request) => {
							const isExpanded = expandedRequests.has(request.id);
							const isError = request.error || !request.meta.success;
							const statusCode = request.response?.status;
							const summary = data?.summaries.get(request.id);
							const method = request.meta.method || summary?.method;
							const path = request.meta.path || summary?.path;
							const accountLabel =
								request.meta.accountName ||
								(request.meta.accountId
									? `${request.meta.accountId.slice(0, 8)}...`
									: null);
							const agent = summary?.agentUsed || request.meta.agentUsed;
							const isZaiPeak =
								zaiAccountNames.has(request.meta.accountName ?? "") &&
								isZaiPeakHour(request.meta.timestamp);
							const isAnthropicPeak =
								oauthAccountNames.has(request.meta.accountName ?? "") &&
								isAnthropicPeakHour(request.meta.timestamp);
							const statusClass =
								statusCode == null
									? ""
									: statusCode >= 200 && statusCode < 300
										? "bg-green-500/10 text-green-600 dark:text-green-400"
										: statusCode >= 400 && statusCode < 500
											? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
											: statusCode >= 500
												? "bg-red-500/10 text-red-600 dark:text-red-400"
												: "bg-muted text-muted-foreground";

							return (
								<div
									key={request.id}
									className={`border rounded-lg transition-all duration-300 ${
										isError ? "border-destructive/50" : "border-border"
									} ${request.meta.pending ? "animate-pulse opacity-70" : "opacity-100"}`}
								>
									{/* Header row: single line, never wraps */}
									<div className="flex items-center gap-2 p-3">
										<button
											type="button"
											className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
											onClick={() => toggleExpanded(request.id)}
											aria-expanded={isExpanded}
										>
											{isExpanded ? (
												<ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
											) : (
												<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
											)}
											<span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0">
												{new Date(request.meta.timestamp).toLocaleTimeString()}
											</span>
											{statusCode != null && (
												<span
													className={`text-xs font-mono font-semibold tabular-nums px-1.5 py-0.5 rounded shrink-0 ${statusClass}`}
												>
													{statusCode}
												</span>
											)}
											{method && (
												<span className="text-xs font-semibold uppercase shrink-0">
													{method}
												</span>
											)}
											{path && (
												<span className="text-xs font-mono text-muted-foreground truncate min-w-0 flex-1">
													{path}
												</span>
											)}
											{summary?.responseTimeMs != null && (
												<span
													className="text-xs font-mono tabular-nums text-muted-foreground shrink-0"
													title="Response time"
												>
													{formatDuration(summary.responseTimeMs)}
												</span>
											)}
											<span
												className="text-[11px] font-mono text-muted-foreground/70 shrink-0 hidden sm:inline"
												title={request.id}
											>
												{request.id.slice(0, 8)}
											</span>
										</button>

										{/* Action buttons stay outside the toggle-expand button so they
										    never get cut off by flex shrinking and have their own hit area. */}
										<div className="flex items-center gap-1 shrink-0">
											<Button
												variant="ghost"
												size="icon"
												onClick={() => setModalRequest(request)}
												title="View Details"
											>
												<Eye className="h-4 w-4" />
											</Button>
											<CopyButton
												variant="ghost"
												size="icon"
												title="Copy as JSON"
												getValueAsync={async () => {
													const full = request.meta.bodiesOmitted
														? await api.getRequestPayload(request.id)
														: request;
													const decoded: RequestPayload & {
														decoded?: true;
													} = {
														...full,
														request: full.request
															? {
																	...full.request,
																	body: full.request.body
																		? decodeBase64(full.request.body)
																		: null,
																}
															: full.request,
														response: full.response
															? {
																	...full.response,
																	body: full.response.body
																		? decodeBase64(full.response.body)
																		: null,
																}
															: null,
														decoded: true,
													};
													return JSON.stringify(decoded, null, 2);
												}}
											/>
										</div>
									</div>

									{/* Badges row: wraps freely, holds all the non-essential context */}
									{(summary?.model ||
										agent ||
										summary?.comboName ||
										summary?.apiKeyName ||
										summary?.totalTokens != null ||
										summary?.costUsd != null ||
										summary?.billingType ||
										(summary?.tokensPerSecond ?? 0) > 0 ||
										accountLabel ||
										request.meta.rateLimited ||
										isZaiPeak ||
										isAnthropicPeak) && (
										<div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pl-9 text-xs">
											{summary?.model && (
												<Badge variant="secondary" className="text-xs">
													{summary.model}
												</Badge>
											)}
											{agent && (
												<Badge variant="secondary" className="text-xs">
													<Bot className="h-3 w-3 mr-1" />
													{agent}
												</Badge>
											)}
											{summary?.comboName && (
												<Badge
													variant="outline"
													className="text-xs border-purple-500 text-purple-500"
												>
													Combo: {summary.comboName}
												</Badge>
											)}
											{summary?.apiKeyName && (
												<Badge variant="outline" className="text-xs">
													<Key className="h-3 w-3 mr-1" />
													{summary.apiKeyName}
												</Badge>
											)}
											{summary?.totalTokens != null && (
												<Badge variant="outline" className="text-xs">
													{formatTokens(summary.totalTokens)} tokens
												</Badge>
											)}
											{summary?.costUsd != null && summary.costUsd > 0 && (
												<Badge variant="default" className="text-xs">
													{formatCost(summary.costUsd)}
												</Badge>
											)}
											{summary?.billingType === "overage" && (
												<Badge
													variant="outline"
													className="text-xs border-orange-500 text-orange-500"
												>
													Overage
												</Badge>
											)}
											{summary?.billingType === "plan" && (
												<Badge
													variant="outline"
													className="text-xs border-teal-500 text-teal-500"
												>
													Plan
												</Badge>
											)}
											{summary?.tokensPerSecond != null &&
												summary.tokensPerSecond > 0 && (
													<Badge variant="secondary" className="text-xs">
														{formatTokensPerSecond(summary.tokensPerSecond)}
													</Badge>
												)}
											{accountLabel && (
												<span className="text-xs text-muted-foreground">
													via {accountLabel}
												</span>
											)}
											{request.meta.rateLimited && (
												<Badge variant="warning" className="text-xs">
													Rate Limited
												</Badge>
											)}
											{(isZaiPeak || isAnthropicPeak) && (
												<Badge
													variant="outline"
													className="text-xs border-orange-500 text-orange-500"
												>
													Peak
												</Badge>
											)}
										</div>
									)}

									{request.error && (
										<div className="text-xs text-destructive px-3 pb-2 pl-9 break-words">
											Error: {request.error}
										</div>
									)}

									{isExpanded && (
										<div className="px-3 pb-3 pl-9 space-y-3">
											<TokenUsageDisplay summary={summary} />
											<Button
												variant="outline"
												size="sm"
												onClick={() => setModalRequest(request)}
												className="w-full"
											>
												<Eye className="h-4 w-4 mr-2" />
												View More Details
											</Button>
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</CardContent>

			{modalRequest && (
				<RequestDetailsModal
					request={modalRequest}
					summary={data?.summaries.get(modalRequest.id)}
					isOpen={true}
					onClose={() => setModalRequest(null)}
				/>
			)}
		</Card>
	);
}
