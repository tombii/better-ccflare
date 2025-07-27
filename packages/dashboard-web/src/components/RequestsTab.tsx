import { ChevronDown, ChevronRight, RefreshCw, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type RequestPayload } from "../api";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

export function RequestsTab() {
	const [requests, setRequests] = useState<RequestPayload[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [expandedRequests, setExpandedRequests] = useState<Set<string>>(
		new Set(),
	);

	const loadRequests = useCallback(async () => {
		try {
			const data = await api.getRequestsDetail(200);
			setRequests(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load requests");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadRequests();
		const interval = setInterval(loadRequests, 10000);
		return () => clearInterval(interval);
	}, [loadRequests]);

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

	const decodeBase64 = (str: string | null): string => {
		if (!str) return "No data";
		try {
			return atob(str);
		} catch {
			return "Failed to decode";
		}
	};

	/**
	 * Copy the given request to the clipboard as pretty-printed JSON, with
	 * any base64-encoded bodies already decoded for easier debugging.
	 */
	const copyRequest = (req: RequestPayload) => {
		const decoded: RequestPayload & { decoded?: true } = {
			...req,
			request: {
				...req.request,
				body: req.request.body ? decodeBase64(req.request.body) : null,
			},
			response: req.response
				? {
					...req.response,
					body: req.response.body ? decodeBase64(req.response.body) : null,
				}
				: null,
			// flag so it's obvious this is a transformed payload
			decoded: true,
		};

		navigator.clipboard
			.writeText(JSON.stringify(decoded, null, 2))
			.catch((err) => console.error("Failed to copy request", err));
	};

	const formatHeaders = (headers: Record<string, string>): string => {
		return Object.entries(headers)
			.map(([key, value]) => `${key}: ${value}`)
			.join("\n");
	};

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
					<p className="text-destructive">Error: {error}</p>
					<Button
						onClick={loadRequests}
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
					<Button onClick={loadRequests} variant="ghost" size="sm">
						<RefreshCw className="h-4 w-4" />
					</Button>
				</div>
			</CardHeader>
			<CardContent>
				{requests.length === 0 ? (
					<p className="text-muted-foreground">No requests found</p>
				) : (
					<div className="space-y-2">
						{requests.map((request) => {
							const isExpanded = expandedRequests.has(request.id);
							const isError = request.error || !request.meta.success;
							const statusCode = request.response?.status;

							return (
								<div
									key={request.id}
									className={`border rounded-lg p-3 ${
										isError ? "border-destructive/50" : "border-border"
									}`}
								>
									<button
										type="button"
										className="flex items-center justify-between cursor-pointer w-full text-left"
										onClick={() => toggleExpanded(request.id)}
									>
										<div className="flex items-center gap-2">
											{isExpanded ? (
												<ChevronDown className="h-4 w-4" />
											) : (
												<ChevronRight className="h-4 w-4" />
											)}
											<span className="text-sm font-mono">
												{new Date(request.meta.timestamp).toLocaleTimeString()}
											</span>
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
											{request.meta.accountId && (
												<span className="text-sm text-muted-foreground">
													via {request.meta.accountId.slice(0, 8)}...
												</span>
											)}
											{request.meta.rateLimited && (
												<span className="text-sm text-orange-600">
													Rate Limited
												</span>
											)}
											{request.error && (
												<span className="text-sm text-destructive">
													Error: {request.error}
												</span>
											)}
										</div>
										<div className="text-sm text-muted-foreground">
											{request.meta.retry !== undefined &&
												request.meta.retry > 0 && (
													<span>Retry {request.meta.retry} • </span>
												)}
											ID: {request.id.slice(0, 8)}...
										</div>
									</button>

									{/* Copy button */}
									<div className="flex justify-end mt-2">
										<Button
											variant="ghost"
											size="icon"
											onClick={() => copyRequest(request)}
											title="Copy as JSON"
										>
											<Copy className="h-4 w-4" />
										</Button>
									</div>

									{isExpanded && (
										<div className="mt-3 space-y-3 text-sm">
											<div>
												<h4 className="font-medium mb-1">Request Headers</h4>
												<pre className="bg-muted p-2 rounded overflow-x-auto text-xs">
													{formatHeaders(request.request.headers)}
												</pre>
											</div>

											{request.request.body && (
												<div>
													<h4 className="font-medium mb-1">Request Body</h4>
													<pre className="bg-muted p-2 rounded overflow-x-auto text-xs max-h-40 overflow-y-auto">
														{decodeBase64(request.request.body)}
													</pre>
												</div>
											)}

											{request.response && (
												<>
													<div>
														<h4 className="font-medium mb-1">
															Response Headers
														</h4>
														<pre className="bg-muted p-2 rounded overflow-x-auto text-xs">
															{formatHeaders(request.response.headers)}
														</pre>
													</div>

													{request.response.body && (
														<div>
															<h4 className="font-medium mb-1">
																Response Body
															</h4>
															<pre className="bg-muted p-2 rounded overflow-x-auto text-xs max-h-40 overflow-y-auto">
																{decodeBase64(request.response.body)}
															</pre>
														</div>
													)}
												</>
											)}

											<div>
												<h4 className="font-medium mb-1">Metadata</h4>
												<pre className="bg-muted p-2 rounded overflow-x-auto text-xs">
													{JSON.stringify(request.meta, null, 2)}
												</pre>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
