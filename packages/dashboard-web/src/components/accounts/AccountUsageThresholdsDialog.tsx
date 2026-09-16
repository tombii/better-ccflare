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
import { Switch } from "../ui/switch";

interface AccountUsageThresholdsDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onUpdateThresholds: (
		accountId: string,
		fiveHour: { enabled: boolean; percent: number | null },
		weekly: { enabled: boolean; percent: number | null },
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
 * Labels for the two threshold rows. The underlying fields (`fiveHour` /
 * `weekly`) and everything they save stay the same for every provider — this
 * only changes what the rows are called, because for NanoGPT accounts those
 * same two slots govern NanoGPT's daily and monthly usage windows instead of
 * a 5-hour/weekly one.
 */
export function getThresholdLabels(account: Account | null): {
	fiveHourLabel: string;
	weeklyLabel: string;
} {
	const isNanoGpt = account?.provider === "nanogpt";
	return {
		fiveHourLabel: isNanoGpt ? "Daily" : "5-hour",
		weeklyLabel: isNanoGpt ? "Monthly" : "Weekly",
	};
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
	const [fiveHourOn, setFiveHourOn] = useState(
		() => account?.usagePauseFiveHourEnabled ?? false,
	);
	const [weeklyOn, setWeeklyOn] = useState(
		() => account?.usagePauseWeeklyEnabled ?? false,
	);
	const [isUpdating, setIsUpdating] = useState(false);
	const { fiveHourLabel, weeklyLabel } = getThresholdLabels(account);

	// Reset the fields whenever the dialog is pointed at another account.
	useEffect(() => {
		setFiveHour(toField(account?.usagePauseFiveHourThreshold));
		setFiveHourOn(account?.usagePauseFiveHourEnabled ?? false);
	}, [
		account?.usagePauseFiveHourThreshold,
		account?.usagePauseFiveHourEnabled,
	]);
	useEffect(() => {
		setWeekly(toField(account?.usagePauseWeeklyThreshold));
		setWeeklyOn(account?.usagePauseWeeklyEnabled ?? false);
	}, [account?.usagePauseWeeklyThreshold, account?.usagePauseWeeklyEnabled]);

	const parsedFiveHour = fromField(fiveHour);
	const parsedWeekly = fromField(weekly);
	const badNumber = parsedFiveHour === "invalid" || parsedWeekly === "invalid";
	// A window switched on with no percentage would pause at nothing; say so
	// rather than saving a setting that quietly does not work.
	const onWithoutPercent =
		(fiveHourOn && parsedFiveHour === null) ||
		(weeklyOn && parsedWeekly === null);
	const hasError = badNumber || onWithoutPercent;

	const handleUpdate = async () => {
		if (
			!account ||
			parsedFiveHour === "invalid" ||
			parsedWeekly === "invalid" ||
			onWithoutPercent
		) {
			return;
		}

		setIsUpdating(true);
		try {
			await onUpdateThresholds(
				account.id,
				{ enabled: fiveHourOn, percent: parsedFiveHour },
				{ enabled: weeklyOn, percent: parsedWeekly },
			);
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to update usage pause thresholds:", error);
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle>Usage Pause Thresholds</DialogTitle>
					<DialogDescription>
						Pause {account?.name} once a usage window reaches its percentage,
						and resume it automatically when that window resets. Each window is
						switched on separately; a window that is off keeps its percentage
						for next time.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<ThresholdRow
						id="usage-threshold-5h"
						label={fiveHourLabel}
						enabled={fiveHourOn}
						onEnabledChange={setFiveHourOn}
						value={fiveHour}
						onValueChange={setFiveHour}
					/>
					<ThresholdRow
						id="usage-threshold-weekly"
						label={weeklyLabel}
						enabled={weeklyOn}
						onEnabledChange={setWeeklyOn}
						value={weekly}
						onValueChange={setWeekly}
					/>
					{badNumber ? (
						<div className="text-sm text-destructive">
							Percentages must be whole numbers between 1 and 100.
						</div>
					) : onWithoutPercent ? (
						<div className="text-sm text-destructive">
							A window that is switched on needs a percentage.
						</div>
					) : (
						<div className="text-sm text-muted-foreground">
							A pause from a threshold is lifted by the usage poller once every
							window that is on is back below its percentage. Pausing the
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

interface ThresholdRowProps {
	id: string;
	label: string;
	enabled: boolean;
	onEnabledChange: (next: boolean) => void;
	value: string;
	onValueChange: (next: string) => void;
}

/**
 * One window: a switch that says whether it is in force, and the percentage
 * it pauses at.
 *
 * The percentage stays editable while the switch is off, so a number can be
 * written down before the window is switched on — and the one already stored
 * stays visible instead of disappearing when the window is turned off.
 */
function ThresholdRow({
	id,
	label,
	enabled,
	onEnabledChange,
	value,
	onValueChange,
}: ThresholdRowProps) {
	return (
		<div className="grid grid-cols-[1fr_auto_auto] items-center gap-3">
			<Label htmlFor={id} className={enabled ? "" : "text-muted-foreground"}>
				{label}
			</Label>
			<div className="flex items-center gap-1">
				<Input
					id={id}
					type="number"
					min="1"
					max="100"
					placeholder="—"
					value={value}
					onChange={(e) => onValueChange(e.target.value)}
					className="w-24"
				/>
				<span
					className={`text-sm ${enabled ? "text-muted-foreground" : "text-muted-foreground/60"}`}
				>
					%
				</span>
			</div>
			<Switch
				checked={enabled}
				onCheckedChange={onEnabledChange}
				title={`Pause on the ${label.toLowerCase()} window`}
			/>
		</div>
	);
}
