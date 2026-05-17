import { HttpError } from "@better-ccflare/http-common";
import {
	formatCost,
	formatTimestamp,
	formatTokens,
} from "@better-ccflare/ui-common";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { ConversationView } from "./ConversationView";
import { CopyButton } from "./CopyButton";
import { TokenUsageDisplay } from "./TokenUsageDisplay";
import { Badge } from "./ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface RequestDetailsModalProps {
	request: RequestPayload;
	summary: RequestSummary | undefined;
	isOpen: boolean;
	onClose: () => void;
}

export function RequestDetailsModal({
	request,
	summary,
	isOpen,
	onClose,
}: RequestDetailsModalProps) {
	const [beautifyMode, setBeautifyMode] = useState(true);
	const [hydrated, setHydrated] = useState<RequestPayload | null>(null);
	const [failedId, setFailedId] = useState<string | null>(null);

	const effective: RequestPayload =
		hydrated && hydrated.id === request.id ? hydrated : request;

	// Hydrate when we have no request payload at all (legacy case), or when
	// the list view handed us a body-less summary placeholder.
	const needsHydration =
		isOpen &&
		!effective.error &&
		!effective.meta?.pending &&
		(!effective.request || effective.meta?.bodiesOmitted === true) &&
		failedId !== request.id;

	useEffect(() => {
		if (!needsHydration) return;
		let cancelled = false;
		api
			.getRequestPayload(request.id)
			.then((payload) => {
				if (!cancelled) setHydrated(payload);
			})
			.catch((err) => {
				if (!cancelled && err instanceof HttpError && err.status === 404)
					setFailedId(request.id);
			});
		return () => {
			cancelled = true;
		};
	}, [needsHydration, request.id]);

	const decodeBase64 = (str: string | null): string => {
		if (!str) return "No data";
		try {
			if (str === "[streamed]") {
				return "[Streaming data not captured]";
			}
			return atob(str);
		} catch (error) {
			console.error("Failed to decode base64:", error, "Input:", str);
			return `Failed to decode: ${str}`;
		}
	};

	const formatJson = (str: string): string => {
		try {
			const parsed = JSON.parse(str);
			return JSON.stringify(parsed, null, 2);
		} catch {
			// If it's not valid JSON, return as-is
			return str;
		}
	};

	const formatHeaders = (headers: Record<string, string>): string => {
		if (!beautifyMode) {
			return Object.entries(headers)
				.map(([key, value]) => `${key}: ${value}`)
				.join("\n");
		}
		return JSON.stringify(headers, null, 2);
	};

	const formatBody = (body: string | null): string => {
		const decoded = decodeBase64(body);
		if (!beautifyMode) return decoded;
		return formatJson(decoded);
	};

	const _isError = effective.error || !request.meta.success;
	const statusCode = effective.response?.status;

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Eye className="h-5 w-5" />
						Request Details
					</DialogTitle>
					<DialogDescription className="flex items-center justify-between">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-mono text-sm">
								{formatTimestamp(request.meta.timestamp)}
							</span>
							{statusCode && (
								<Badge
									variant={
										statusCode >= 200 && statusCode < 300
											? "success"
											: statusCode >= 400 && statusCode < 500
												? "warning"
												: "destructive"
									}
								>
									{statusCode}
								</Badge>
							)}
							{summary?.model && (
								<Badge variant="secondary">{summary.model}</Badge>
							)}
							{summary?.agentUsed && (
								<Badge variant="secondary">Agent: {summary.agentUsed}</Badge>
							)}
							{summary?.totalTokens && (
								<Badge variant="outline">
									{formatTokens(summary.totalTokens)} tokens
								</Badge>
							)}
							{summary?.costUsd && summary.costUsd > 0 && (
								<Badge variant="default">{formatCost(summary.costUsd)}</Badge>
							)}
						</div>
						<div className="flex items-center gap-2">
							<Label htmlFor="beautify-mode" className="text-sm">
								Beautify
							</Label>
							<Switch
								id="beautify-mode"
								checked={beautifyMode}
								onCheckedChange={setBeautifyMode}
							/>
						</div>
					</DialogDescription>
				</DialogHeader>

				<Tabs defaultValue="conversation" className="flex-1 overflow-hidden">
					<TabsList className="grid w-full grid-cols-5">
						<TabsTrigger value="conversation">Conversation</TabsTrigger>
						<TabsTrigger value="request">Request</TabsTrigger>
						<TabsTrigger value="response">Response</TabsTrigger>
						<TabsTrigger value="metadata">Metadata</TabsTrigger>
						<TabsTrigger value="tokens">Token Usage</TabsTrigger>
					</TabsList>

					<TabsContent value="conversation" className="mt-4 flex-1 min-h-0">
						<ConversationView
							requestBody={decodeBase64(effective.request?.body ?? null)}
							responseBody={decodeBase64(effective.response?.body || null)}
						/>
					</TabsContent>

					<TabsContent
						value="request"
						className="mt-4 space-y-4 overflow-y-auto max-h-[60vh]"
					>
						{effective.request ? (
							<>
								<div>
									<div className="flex items-center justify-between mb-2">
										<h3 className="font-semibold">Headers</h3>
										<CopyButton
											variant="ghost"
											size="sm"
											getValue={() => formatHeaders(effective.request.headers)}
										>
											Copy
										</CopyButton>
									</div>
									<pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono">
										{formatHeaders(effective.request.headers)}
									</pre>
								</div>

								{effective.request.body && (
									<div>
										<div className="flex items-center justify-between mb-2">
											<h3 className="font-semibold">Body</h3>
											<CopyButton
												variant="ghost"
												size="sm"
												getValue={() => formatBody(effective.request.body)}
											>
												Copy
											</CopyButton>
										</div>
										<pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono">
											{formatBody(effective.request.body)}
										</pre>
									</div>
								)}
							</>
						) : (
							<div className="text-center text-muted-foreground py-8">
								{needsHydration
									? "Loading payload…"
									: "No request data available"}
							</div>
						)}
					</TabsContent>

					<TabsContent
						value="response"
						className="mt-4 space-y-4 overflow-y-auto max-h-[60vh]"
					>
						{effective.response ? (
							<>
								<div>
									<div className="flex items-center justify-between mb-2">
										<h3 className="font-semibold">Headers</h3>
										<CopyButton
											variant="ghost"
											size="sm"
											getValue={() =>
												effective.response
													? formatHeaders(effective.response.headers)
													: ""
											}
										>
											Copy
										</CopyButton>
									</div>
									<pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono">
										{formatHeaders(effective.response.headers)}
									</pre>
								</div>

								{effective.response.body && (
									<div>
										<div className="flex items-center justify-between mb-2">
											<h3 className="font-semibold">Body</h3>
											<CopyButton
												variant="ghost"
												size="sm"
												getValue={() =>
													effective.response
														? formatBody(effective.response.body)
														: ""
												}
											>
												Copy
											</CopyButton>
										</div>
										<pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono">
											{formatBody(effective.response.body)}
										</pre>
									</div>
								)}
							</>
						) : (
							<div className="text-center text-muted-foreground py-8">
								{effective.error ? (
									<>
										<p className="text-destructive font-medium">
											Error: {effective.error}
										</p>
										<p className="mt-2">No response data available</p>
									</>
								) : (
									<p>No response data available</p>
								)}
							</div>
						)}
					</TabsContent>

					<TabsContent
						value="metadata"
						className="mt-4 overflow-y-auto max-h-[60vh]"
					>
						<div>
							<div className="flex items-center justify-between mb-2">
								<h3 className="font-semibold">Request Metadata</h3>
								<CopyButton
									variant="ghost"
									size="sm"
									getValue={() =>
										beautifyMode
											? JSON.stringify(request.meta, null, 2)
											: JSON.stringify(request.meta)
									}
								>
									Copy
								</CopyButton>
							</div>
							<pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono">
								{beautifyMode
									? JSON.stringify(request.meta, null, 2)
									: JSON.stringify(request.meta)}
							</pre>
						</div>
					</TabsContent>

					<TabsContent
						value="tokens"
						className="mt-4 overflow-y-auto max-h-[60vh]"
					>
						<TokenUsageDisplay summary={summary} />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
