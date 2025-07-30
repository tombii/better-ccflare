import {
	formatCost,
	formatDuration,
	formatTokens,
	formatTokensPerSecond,
} from "@ccflare/ui-common";
import {
	Calendar,
	ChevronDown,
	ChevronRight,
	Clock,
	Eye,
	Filter,
	RefreshCw,
	X,
} from "lucide-react";
import { useState } from "react";
import type { RequestPayload, RequestSummary } from "../api";
import { useRequests } from "../hooks/queries";
import { useRequestStream } from "../hooks/useRequestStream";
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
	} = useRequests(200);

	// Enable real-time updates
	useRequestStream(200);

	// Transform the data to match the expected structure
	const data = requestsData
		? {
				requests: requestsData.requests,
				summaries: new Map(
					requestsData.detailsMap instanceof Map
						? requestsData.detailsMap
						: requestsData.detailsMap.map(
								(s: RequestSummary) => [s.id, s] as [string, RequestSummary],
							),
				),
			}
		: null;

	// Extract unique accounts for filter dropdown
	const uniqueAccounts = data
		? Array.from(
				new Set(
					data.requests
						.map((r) => r.meta.accountName || r.meta.accountId)
						.filter(Boolean),
				),
			).sort()
		: [];

	// Extract unique status codes for filter
	const uniqueStatusCodes = data
		? Array.from(
				new Set(
					data.requests
						.map((r) => r.response?.status)
						.filter((status): status is number => status !== undefined),
				),
			).sort((a, b) => a - b)
		: [];

	// Filter requests based on selected filters
	const filteredRequests = data
		? data.requests.filter((request) => {
				// Account filter
				if (accountFilter !== "all") {
					const requestAccount =
						request.meta.accountName || request.meta.accountId;
					if (requestAccount !== accountFilter) return false;
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
			})
		: [];

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
		setDateFrom("");
		setDateTo("");
		setStatusCodeFilters(new Set());
	};

	const hasActiveFilters =
		accountFilter !== "all" || dateFrom || dateTo || statusCodeFilters.size > 0;

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
							Detailed request and response data (last 200)
						</CardDescription>
					</div>
					<div className="flex gap-2">
						<Button
							onClick={() => setShowFilters(!showFilters)}
							variant="outline"
							size="sm"
							className="relative"
						>
							<Filter className="h-4 w-4 mr-2" />
							Filters
							{hasActiveFilters && (
								<span className="absolute -top-1 -right-1 h-2 w-2 bg-primary rounded-full" />
							)}
						</Button>
						<Button onClick={() => loadRequests()} variant="ghost" size="sm">
							<RefreshCw className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{/* Active Filters Display */}
				{hasActiveFilters && !showFilters && (
					<div className="mb-4 flex flex-wrap items-center gap-2">
						<span className="text-sm text-muted-foreground">
							Active filters:
						</span>
						{accountFilter !== "all" && (
							<Badge variant="secondary" className="gap-1">
								Account: {accountFilter}
								<button
									type="button"
									onClick={() => setAccountFilter("all")}
									className="ml-1 hover:text-destructive"
								>
									<X className="h-3 w-3" />
								</button>
							</Badge>
						)}
						{statusCodeFilters.size > 0 && (
							<Badge variant="secondary" className="gap-1">
								Status: {Array.from(statusCodeFilters).join(", ")}
								<button
									type="button"
									onClick={() => setStatusCodeFilters(new Set())}
									className="ml-1 hover:text-destructive"
								>
									<X className="h-3 w-3" />
								</button>
							</Badge>
						)}
						{(dateFrom || dateTo) && (
							<Badge variant="secondary" className="gap-1">
								Date range
								<button
									type="button"
									onClick={() => {
										setDateFrom("");
										setDateTo("");
									}}
									className="ml-1 hover:text-destructive"
								>
									<X className="h-3 w-3" />
								</button>
							</Badge>
						)}
						<Button
							variant="ghost"
							size="sm"
							onClick={clearAllFilters}
							className="h-6 px-2 text-xs"
						>
							Clear all
						</Button>
					</div>
				)}

				{/* Filters Panel */}
				{showFilters && (
					<div className="mb-6 space-y-4 p-6 border rounded-lg bg-muted/30">
						{/* Quick Presets */}
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm font-medium">Quick filters:</span>
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => applyDatePreset("1h")}
									className="h-8"
								>
									<Clock className="h-3 w-3 mr-1" />
									Last hour
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => applyDatePreset("24h")}
									className="h-8"
								>
									<Clock className="h-3 w-3 mr-1" />
									Last 24h
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => applyDatePreset("7d")}
									className="h-8"
								>
									<Calendar className="h-3 w-3 mr-1" />
									Last 7 days
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => applyDatePreset("30d")}
									className="h-8"
								>
									<Calendar className="h-3 w-3 mr-1" />
									Last 30 days
								</Button>
							</div>
						</div>

						<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
							{/* Account Filter */}
							<div className="space-y-2">
								<Label htmlFor="account-filter" className="text-sm font-medium">
									Account
								</Label>
								<Select value={accountFilter} onValueChange={setAccountFilter}>
									<SelectTrigger id="account-filter" className="h-9">
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

							{/* Status Code Filter */}
							<div className="space-y-2">
								<Label className="text-sm font-medium">Status Code</Label>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="outline"
											className="h-9 w-full justify-between font-normal"
										>
											{statusCodeFilters.size > 0
												? `${statusCodeFilters.size} selected`
												: "All status codes"}
											<ChevronDown className="h-4 w-4 opacity-50" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent className="w-56 max-h-64 overflow-y-auto">
										{uniqueStatusCodes.map((code) => (
											<button
												key={code}
												type="button"
												className="flex items-center space-x-2 p-2 hover:bg-accent rounded cursor-pointer w-full text-left"
												onClick={() => toggleStatusCode(code.toString())}
											>
												<div
													className={`w-4 h-4 border rounded flex-shrink-0 ${
														statusCodeFilters.has(code.toString())
															? "bg-primary border-primary"
															: "border-input"
													}`}
												>
													{statusCodeFilters.has(code.toString()) && (
														<svg
															className="w-4 h-4 text-primary-foreground"
															fill="none"
															viewBox="0 0 24 24"
															stroke="currentColor"
															role="img"
															aria-label="Selected"
														>
															<title>Selected</title>
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth={2}
																d="M5 13l4 4L19 7"
															/>
														</svg>
													)}
												</div>
												<span className={`text-sm ${getStatusCodeColor(code)}`}>
													{code}
												</span>
											</button>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>

							{/* Date From */}
							<div className="space-y-2">
								<Label htmlFor="date-from" className="text-sm font-medium">
									From Date
								</Label>
								<Input
									id="date-from"
									type="datetime-local"
									value={dateFrom}
									onChange={(e) => setDateFrom(e.target.value)}
									className="h-9"
								/>
							</div>

							{/* Date To */}
							<div className="space-y-2">
								<Label htmlFor="date-to" className="text-sm font-medium">
									To Date
								</Label>
								<Input
									id="date-to"
									type="datetime-local"
									value={dateTo}
									onChange={(e) => setDateTo(e.target.value)}
									className="h-9"
								/>
							</div>
						</div>

						{/* Actions */}
						<div className="flex items-center justify-between pt-2">
							<div className="text-sm text-muted-foreground">
								{data && (
									<span>
										Showing {filteredRequests.length} of {data.requests.length}{" "}
										requests
									</span>
								)}
							</div>
							<div className="flex gap-2">
								{hasActiveFilters && (
									<Button variant="ghost" size="sm" onClick={clearAllFilters}>
										Clear all filters
									</Button>
								)}
								<Button
									variant="outline"
									size="sm"
									onClick={() => setShowFilters(false)}
								>
									Close
								</Button>
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
							const summary = data.summaries.get(request.id);

							return (
								<div
									key={request.id}
									className={`border rounded-lg p-3 transition-all duration-300 ${
										isError ? "border-destructive/50" : "border-border"
									} ${request.meta.pending ? "animate-pulse opacity-70" : "opacity-100"}`}
								>
									<button
										type="button"
										className="flex items-center justify-between cursor-pointer w-full text-left"
										onClick={() => toggleExpanded(request.id)}
									>
										<div className="flex items-center gap-2 flex-wrap">
											{isExpanded ? (
												<ChevronDown className="h-4 w-4" />
											) : (
												<ChevronRight className="h-4 w-4" />
											)}
											<span className="text-sm font-mono">
												{new Date(request.meta.timestamp).toLocaleTimeString()}
											</span>
											{(request.meta.method || summary?.method) && (
												<span className="text-sm font-medium">
													{request.meta.method || summary?.method}
												</span>
											)}
											{(request.meta.path || summary?.path) && (
												<span className="text-sm text-muted-foreground font-mono">
													{request.meta.path || summary?.path}
												</span>
											)}
											{statusCode && (
												<span
													className={`text-sm font-medium ${
														statusCode >= 200 && statusCode < 300
															? "text-green-600"
															: statusCode >= 400 && statusCode < 500
																? "text-yellow-600"
																: "text-red-600"
													}`}
												>
													{statusCode}
												</span>
											)}
											{summary?.model && (
												<Badge variant="secondary" className="text-xs">
													{summary.model}
												</Badge>
											)}
											{summary?.agentUsed && (
												<Badge variant="secondary" className="text-xs">
													Agent: {summary.agentUsed}
												</Badge>
											)}
											{(summary?.totalTokens || request.meta.pending) && (
												<Badge variant="outline" className="text-xs">
													{summary?.totalTokens
														? formatTokens(summary.totalTokens)
														: "--"}{" "}
													tokens
												</Badge>
											)}
											{(summary?.costUsd || request.meta.pending) && (
												<Badge variant="default" className="text-xs">
													{summary?.costUsd && summary.costUsd > 0
														? formatCost(summary.costUsd)
														: "--"}
												</Badge>
											)}
											{summary?.tokensPerSecond &&
												summary.tokensPerSecond > 0 && (
													<Badge variant="secondary" className="text-xs">
														{formatTokensPerSecond(summary.tokensPerSecond)}
													</Badge>
												)}
											{(request.meta.accountName || request.meta.accountId) && (
												<span className="text-sm text-muted-foreground">
													via{" "}
													{request.meta.accountName ||
														`${request.meta.accountId?.slice(0, 8)}...`}
												</span>
											)}
											{request.meta.rateLimited && (
												<Badge variant="warning" className="text-xs">
													Rate Limited
												</Badge>
											)}
											{request.error && (
												<span className="text-sm text-destructive">
													Error: {request.error}
												</span>
											)}
										</div>
										<div className="text-sm text-muted-foreground flex items-center gap-2">
											{(summary?.responseTimeMs || request.meta.pending) && (
												<span>
													{summary?.responseTimeMs
														? formatDuration(summary.responseTimeMs)
														: "--"}
												</span>
											)}
											{request.meta.retry !== undefined &&
												request.meta.retry > 0 && (
													<span>Retry {request.meta.retry}</span>
												)}
											<span>ID: {request.id.slice(0, 8)}...</span>
										</div>
									</button>

									{/* Action buttons */}
									<div className="flex justify-end gap-2 mt-2">
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
											getValue={() => {
												const decoded: RequestPayload & { decoded?: true } = {
													...request,
													request: {
														...request.request,
														body: request.request.body
															? decodeBase64(request.request.body)
															: null,
													},
													response: request.response
														? {
																...request.response,
																body: request.response.body
																	? decodeBase64(request.response.body)
																	: null,
															}
														: null,
													decoded: true,
												};
												return JSON.stringify(decoded, null, 2);
											}}
										/>
									</div>

									{isExpanded && (
										<div className="mt-3 space-y-3">
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
