import { useEffect, useState } from "react";
import type { Account } from "../../api";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface AccountUsageThresholdsDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onUpdateThresholds: (
		accountId: string,
		fiveHour: number | null,
		weekly: number | null,
	) => Promise<void>;
}

/** Render a stored threshold as the text its field shows; null is an empty field. */
function toField(value: number | null | undefined): string {
	return value === null || value === undefined ? "" : String(value);
}

/**
 * Read one field back: the percentage, null for an empty field ("no
 * threshold"), or "invalid" for anything the server would reject.
 */
function fromField(value: string): number | null | "invalid" {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return "invalid";
	return parsed;
}

/**
 * Per-account usage pause thresholds: bench the account once a usage window
 * reaches the given percentage, and let it back in when the window resets.
 *
 * Both fields are optional and are saved together — an empty field means that
 * window has no threshold.
 */
export function AccountUsageThresholdsDialog({
	account,
	isOpen,
	onOpenChange,
	onUpdateThresholds,
}: AccountUsageThresholdsDialogProps) {
	const [fiveHour, setFiveHour] = useState(() =>
		toField(account?.usagePauseFiveHourThreshold),
	);
	const [weekly, setWeekly] = useState(() =>
		toField(account?.usagePauseWeeklyThreshold),
	);
	const [isUpdating, setIsUpdating] = useState(false);

	// Reset the fields whenever the dialog is pointed at another account.
	useEffect(() => {
		setFiveHour(toField(account?.usagePauseFiveHourThreshold));
		setWeekly(toField(account?.usagePauseWeeklyThreshold));
	}, [
		account?.usagePauseFiveHourThreshold,
		account?.usagePauseWeeklyThreshold,
	]);

	const parsedFiveHour = fromField(fiveHour);
	const parsedWeekly = fromField(weekly);
	const hasError = parsedFiveHour === "invalid" || parsedWeekly === "invalid";

	const handleUpdate = async () => {
		if (
			!account ||
			parsedFiveHour === "invalid" ||
			parsedWeekly === "invalid"
		) {
			return;
		}

		setIsUpdating(true);
		try {
			await onUpdateThresholds(account.id, parsedFiveHour, parsedWeekly);
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to update usage pause thresholds:", error);
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[480px]">
				<DialogHeader>
					<DialogTitle>Usage Pause Thresholds</DialogTitle>
					<DialogDescription>
						Pause {account?.name} once a usage window reaches the given
						percentage, and resume it automatically when that window resets.
						Leave a field empty for no threshold.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid grid-cols-4 items-center gap-4">
						<Label htmlFor="usage-threshold-5h" className="text-right">
							5-hour
						</Label>
						<Input
							id="usage-threshold-5h"
							type="number"
							min="1"
							max="100"
							placeholder="off"
							value={fiveHour}
							onChange={(e) => setFiveHour(e.target.value)}
							className="col-span-3"
						/>
					</div>
					<div className="grid grid-cols-4 items-center gap-4">
						<Label htmlFor="usage-threshold-weekly" className="text-right">
							Weekly
						</Label>
						<Input
							id="usage-threshold-weekly"
							type="number"
							min="1"
							max="100"
							placeholder="off"
							value={weekly}
							onChange={(e) => setWeekly(e.target.value)}
							className="col-span-3"
						/>
					</div>
					{hasError ? (
						<div className="text-sm text-destructive">
							Thresholds must be whole numbers between 1 and 100, or empty.
						</div>
					) : (
						<div className="text-sm text-muted-foreground">
							A pause from a threshold is lifted by the usage poller once every
							configured window is back below its percentage. Pausing the
							account by hand is never overridden.
						</div>
					)}
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={handleUpdate}
						disabled={isUpdating || hasError}
					>
						{isUpdating ? "Saving..." : "Save Thresholds"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
