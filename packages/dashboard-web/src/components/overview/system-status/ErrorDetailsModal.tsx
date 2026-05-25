import type { RecentErrorGroup } from "@better-ccflare/types";
import { formatTimestamp } from "@better-ccflare/ui-common";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/dialog";
import { Separator } from "../../ui/separator";
import { getErrorMeta } from "./errorCodeMeta";

interface ErrorDetailsModalProps {
	error: RecentErrorGroup | null;
	otherAccountsAvailable: boolean;
	onClose: () => void;
	onDismiss: (group: RecentErrorGroup) => void;
}

function accountValue(error: RecentErrorGroup): string {
	if (error.accountName)
		return `${error.accountName} (ID: ${error.accountId ?? "unknown"})`;
	if (error.accountId === null) return "Unauthenticated";
	return `Deleted account (ID: ${error.accountId})`;
}

function recoveryValue(rateLimitedUntil: number): string {
	if (rateLimitedUntil <= Date.now()) return "Recovered";
	const remaining = formatDistanceToNow(new Date(rateLimitedUntil), {
		addSuffix: false,
	});
	return `Recovering in ${remaining}`;
}

interface DetailRowProps {
	label: string;
	children: ReactNode;
}

function DetailRow({ label, children }: DetailRowProps) {
	return (
		<div>
			<p className="text-xs text-muted-foreground uppercase tracking-wide">
				{label}
			</p>
			<div className="text-sm mt-0.5">{children}</div>
		</div>
	);
}

export function ErrorDetailsModal({
	error,
	otherAccountsAvailable,
	onClose,
	onDismiss,
}: ErrorDetailsModalProps) {
	const open = error !== null;

	const meta = error
		? getErrorMeta(error.errorCode, {
				provider: error.provider,
				otherAccountsAvailable,
			})
		: null;
	const isWarning = meta?.severity === "warning";
	const Icon = isWarning ? AlertTriangle : XCircle;
	const iconColor = isWarning ? "text-warning" : "text-destructive";

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
				{error && meta && (
					<>
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2">
								<Icon className={`h-5 w-5 ${iconColor}`} />
								{meta.title}
							</DialogTitle>
							<DialogDescription>{meta.description}</DialogDescription>
						</DialogHeader>

						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<DetailRow label="Error code">
								<code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
									{error.errorCode}
								</code>
							</DetailRow>
							<DetailRow label="Account">{accountValue(error)}</DetailRow>
							{error.model && (
								<DetailRow label="Model">{error.model}</DetailRow>
							)}
							{error.statusCode != null && (
								<DetailRow label="HTTP status">{error.statusCode}</DetailRow>
							)}
							{error.path && (
								<DetailRow label="Path">
									<span className="font-mono text-xs break-all">
										{error.path}
									</span>
								</DetailRow>
							)}
							<DetailRow label="Failover attempts">
								{error.failoverAttempts}
							</DetailRow>
							<DetailRow label="First seen">
								{formatDistanceToNow(new Date(error.firstTimestamp), {
									addSuffix: true,
								})}
								<span className="text-muted-foreground">
									{" · "}
									{formatTimestamp(error.firstTimestamp)}
								</span>
							</DetailRow>
							<DetailRow label="Last seen">
								{formatDistanceToNow(new Date(error.latestTimestamp), {
									addSuffix: true,
								})}
								<span className="text-muted-foreground">
									{" · "}
									{formatTimestamp(error.latestTimestamp)}
								</span>
							</DetailRow>
							<DetailRow label="Occurrence count">
								{error.occurrenceCount}
							</DetailRow>
							<DetailRow label="Latest request ID">
								<code className="font-mono text-xs break-all">
									{error.latestRequestId}
								</code>
							</DetailRow>
							{error.rateLimitedUntil != null && (
								<DetailRow label="Recovery">
									{recoveryValue(error.rateLimitedUntil)}
								</DetailRow>
							)}
						</div>

						<Separator />

						<div className="rounded-lg bg-muted/50 p-3 text-sm">
							<p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
								Suggestion
							</p>
							{meta.suggestion}
						</div>

						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => {
									onDismiss(error);
									onClose();
								}}
							>
								Dismiss
							</Button>
							<Button variant="default" onClick={onClose}>
								Close
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
