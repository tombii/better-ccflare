import { useEffect, useId, useState } from "react";
import type { Account } from "../../api";
import { Input } from "../ui/input";

interface UsagePauseThresholdsProps {
	account: Account;
	onSave: (
		account: Account,
		fiveHour: number | null,
		weekly: number | null,
	) => Promise<void>;
}

/** Render a stored threshold as the text the field shows; null is an empty field. */
function toField(value: number | null | undefined): string {
	return value === null || value === undefined ? "" : String(value);
}

/**
 * Read one field back. Returns the parsed percentage, null for an empty field
 * ("no threshold"), or "invalid" for anything the server would reject, so the
 * caller can decline to save rather than round-trip a 400.
 */
function fromField(value: string): number | null | "invalid" {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return "invalid";
	return parsed;
}

/**
 * The per-account "pause at N%" fields: one for the 5-hour window, one for the
 * weekly one. An empty field means the window has no threshold.
 *
 * Edits commit on blur (and on Enter) rather than on every keystroke — typing
 * "80" passes through "8", and saving that would bench the account instantly.
 */
export function UsagePauseThresholds({
	account,
	onSave,
}: UsagePauseThresholdsProps) {
	const [fiveHour, setFiveHour] = useState(() =>
		toField(account.usagePauseFiveHourThreshold),
	);
	const [weekly, setWeekly] = useState(() =>
		toField(account.usagePauseWeeklyThreshold),
	);

	// Re-sync when the account refreshes underneath us (poll, or another tab).
	useEffect(() => {
		setFiveHour(toField(account.usagePauseFiveHourThreshold));
	}, [account.usagePauseFiveHourThreshold]);
	useEffect(() => {
		setWeekly(toField(account.usagePauseWeeklyThreshold));
	}, [account.usagePauseWeeklyThreshold]);

	const commit = async () => {
		const nextFiveHour = fromField(fiveHour);
		const nextWeekly = fromField(weekly);
		if (nextFiveHour === "invalid" || nextWeekly === "invalid") return;
		if (
			nextFiveHour === (account.usagePauseFiveHourThreshold ?? null) &&
			nextWeekly === (account.usagePauseWeeklyThreshold ?? null)
		) {
			return;
		}
		await onSave(account, nextFiveHour, nextWeekly);
	};

	return (
		<div className="flex items-center gap-2">
			<span className="text-xs text-muted-foreground">Pause at:</span>
			<ThresholdField
				label="5h %"
				value={fiveHour}
				onValueChange={setFiveHour}
				onCommit={commit}
				title="Pause this account once its 5-hour usage window reaches this percentage. Leave empty for no threshold. The account resumes automatically once the window resets."
			/>
			<ThresholdField
				label="weekly %"
				value={weekly}
				onValueChange={setWeekly}
				onCommit={commit}
				title="Pause this account once its weekly usage window reaches this percentage. Leave empty for no threshold. The account resumes automatically once the window resets."
			/>
		</div>
	);
}

interface ThresholdFieldProps {
	label: string;
	value: string;
	title: string;
	onValueChange: (next: string) => void;
	onCommit: () => void;
}

/** One labelled percentage box. Empty means the window has no threshold. */
function ThresholdField({
	label,
	value,
	title,
	onValueChange,
	onCommit,
}: ThresholdFieldProps) {
	const id = useId();

	return (
		<div className="flex items-center gap-1" title={title}>
			<label htmlFor={id} className="text-xs text-muted-foreground">
				{label}
			</label>
			<Input
				id={id}
				type="number"
				min={1}
				max={100}
				placeholder="off"
				className="h-7 w-16 px-2 text-xs"
				value={value}
				onChange={(e) => onValueChange(e.target.value)}
				onBlur={onCommit}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
			/>
		</div>
	);
}
