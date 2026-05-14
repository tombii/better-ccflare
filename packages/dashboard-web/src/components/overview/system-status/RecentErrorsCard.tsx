import { NO_ACCOUNT_ID, type RecentErrorGroup } from "@better-ccflare/types";
import { useState } from "react";
import { useStats } from "../../../hooks/queries";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui/select";
import { ErrorDetailsModal } from "./ErrorDetailsModal";
import { RecentErrorRow } from "./RecentErrorRow";
import { useDismissedErrors } from "./useDismissedErrors";
import { type ErrorWindowKey, useErrorWindow } from "./useErrorWindow";

const WINDOW_OPTIONS: Array<{ value: ErrorWindowKey; label: string }> = [
	{ value: "1h", label: "Last hour" },
	{ value: "24h", label: "Last 24 hours" },
	{ value: "7d", label: "Last 7 days" },
	{ value: "all", label: "All time" },
];

export function RecentErrorsCard() {
	const { windowKey, setWindowKey, windowHours } = useErrorWindow();
	const { data, isLoading } = useStats(undefined, windowHours);
	const { dismiss, isDismissed } = useDismissedErrors();
	const [selectedError, setSelectedError] = useState<RecentErrorGroup | null>(
		null,
	);

	const recentErrors = data?.recentErrors as RecentErrorGroup[] | undefined;
	const visibleErrors = recentErrors?.filter((err) => !isDismissed(err)) ?? [];

	if (isLoading && !data) return null;
	if (visibleErrors.length === 0) return null;

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<h4 className="text-sm font-medium text-muted-foreground">
					Recent Errors
				</h4>
				<Select
					value={windowKey}
					onValueChange={(v) => setWindowKey(v as ErrorWindowKey)}
				>
					<SelectTrigger className="w-[140px] h-8 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{WINDOW_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-2">
				{visibleErrors.map((error) => (
					<RecentErrorRow
						key={`${error.accountId ?? NO_ACCOUNT_ID}:${error.errorCode}:${error.latestRequestId}`}
						error={error}
						onClick={() => setSelectedError(error)}
						onDismiss={() => dismiss(error)}
					/>
				))}
			</div>

			<ErrorDetailsModal
				error={selectedError}
				onClose={() => setSelectedError(null)}
				onDismiss={(group) => dismiss(group)}
			/>
		</div>
	);
}
