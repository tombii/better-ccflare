import type { RecentErrorGroup } from "@better-ccflare/types";
import { formatTimestamp } from "@better-ccflare/ui-common";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, X, XCircle } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { getErrorMeta } from "./errorCodeMeta";

interface RecentErrorRowProps {
	error: RecentErrorGroup;
	otherAccountsAvailable: boolean;
	onClick: () => void;
	onDismiss: () => void;
}

function accountLabel(error: RecentErrorGroup): string {
	if (error.accountName) return error.accountName;
	if (error.accountId === null) return "Unauthenticated";
	return "Deleted account";
}

export function RecentErrorRow({
	error,
	otherAccountsAvailable,
	onClick,
	onDismiss,
}: RecentErrorRowProps) {
	const meta = getErrorMeta(error.errorCode, {
		provider: error.provider,
		otherAccountsAvailable,
	});
	const isWarning = meta.severity === "warning";
	const Icon = isWarning ? AlertTriangle : XCircle;
	const bgClass = isWarning ? "bg-warning/10" : "bg-destructive/10";
	const iconColor = isWarning ? "text-warning" : "text-destructive";

	const relativeTime = formatDistanceToNow(new Date(error.latestTimestamp), {
		addSuffix: true,
	});
	const absoluteTime = formatTimestamp(error.latestTimestamp);

	return (
		// biome-ignore lint/a11y/useSemanticElements: a real <button> would nest the dismiss <Button>, which is invalid HTML and breaks stopPropagation
		<div
			role="button"
			tabIndex={0}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick();
				}
			}}
			className={`w-full text-left p-3 rounded-lg flex items-start gap-2 cursor-pointer transition-colors hover:bg-opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${bgClass}`}
		>
			<Icon className={`h-4 w-4 mt-0.5 shrink-0 ${iconColor}`} />
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium truncate">{meta.title}</p>
				<p className="text-xs text-muted-foreground truncate">
					{accountLabel(error)}
					{error.model ? ` · ${error.model}` : ""}
					{error.statusCode != null ? ` · ${error.statusCode}` : ""}
				</p>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				{error.occurrenceCount > 1 && (
					<Badge
						variant="secondary"
						aria-label={`${error.occurrenceCount} occurrences`}
					>
						×{error.occurrenceCount}
					</Badge>
				)}
				<span
					className="text-xs text-muted-foreground whitespace-nowrap"
					title={absoluteTime}
				>
					{relativeTime}
				</span>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 w-7 p-0"
					aria-label="Dismiss error"
					onClick={(e) => {
						e.stopPropagation();
						onDismiss();
					}}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			</div>
		</div>
	);
}
