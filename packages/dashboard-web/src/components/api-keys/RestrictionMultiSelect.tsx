import { AlertTriangle } from "lucide-react";
import { Label } from "../ui/label";

export interface RestrictionOption {
	value: string;
	label: string;
	/** Secondary text on the same row (provider name, model display name, ...). */
	hint?: string;
	/** The value is selected but matches nothing we know about - a dangling id. */
	unknown?: boolean;
}

export interface RestrictionOptionGroup {
	/** Omit for a single ungrouped list. */
	label?: string;
	options: RestrictionOption[];
}

export interface RestrictionMultiSelectProps {
	/** Prefix for the generated input ids; must be unique on the page. */
	id: string;
	/** Plural, capitalised: "Accounts". */
	title: string;
	/** Singular, lowercase, for the deny-all warning: "account". */
	noun: string;
	groups: RestrictionOptionGroup[];
	/** null = unrestricted; an array (possibly empty) = the allow-list. */
	value: string[] | null;
	onChange: (next: string[] | null) => void;
	disabled?: boolean;
	/** Shown in place of the list when there is nothing to tick. */
	emptyHint?: string;
}

/**
 * One restriction field: an on/off switch over a checkbox list.
 *
 * The switch exists because `null` and `[]` are different states that a plain
 * checkbox list cannot tell apart - unticking the last box would otherwise
 * read as "no restriction" when it actually means "deny everything". Off is
 * null, on is the array, and an empty array while on gets a loud warning
 * rather than being quietly normalised away.
 */
export function RestrictionMultiSelect({
	id,
	title,
	noun,
	groups,
	value,
	onChange,
	disabled,
	emptyHint,
}: RestrictionMultiSelectProps) {
	const restricted = value !== null;
	const selected = value ?? [];
	const total = groups.reduce((sum, group) => sum + group.options.length, 0);

	const toggle = (option: string, checked: boolean) => {
		onChange(
			checked
				? [...selected, option]
				: selected.filter((entry) => entry !== option),
		);
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center space-x-2">
				<input
					type="checkbox"
					id={`${id}-restrict`}
					checked={restricted}
					disabled={disabled}
					onChange={(e) => onChange(e.target.checked ? [] : null)}
					className="h-4 w-4 rounded border-gray-300 disabled:cursor-not-allowed disabled:opacity-60"
				/>
				<Label
					htmlFor={`${id}-restrict`}
					className="text-sm font-normal cursor-pointer"
				>
					Restrict {title}
				</Label>
				{!restricted && (
					<span className="text-xs text-muted-foreground">
						Any {noun} allowed
					</span>
				)}
			</div>

			{restricted && (
				<div className="space-y-2 pl-6">
					<Label>
						{title} ({selected.length} selected)
					</Label>
					{total === 0 ? (
						<p className="text-xs text-muted-foreground">
							{emptyHint ?? `No ${noun} to choose from.`}
						</p>
					) : (
						<div className="border rounded-md p-2 max-h-32 overflow-y-auto space-y-1">
							{groups.map((group) => (
								<div key={group.label ?? "__default"} className="space-y-1">
									{group.label && (
										<div className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
											{group.label}
										</div>
									)}
									{group.options.map((option) => (
										<label
											key={option.value}
											className="flex items-center space-x-2 cursor-pointer hover:bg-muted/50 p-1 rounded"
											title={option.unknown ? option.value : undefined}
										>
											<input
												type="checkbox"
												className="rounded border-gray-300"
												checked={selected.includes(option.value)}
												onChange={(e) => toggle(option.value, e.target.checked)}
											/>
											<span
												className={`text-sm truncate ${option.unknown ? "text-yellow-700" : ""}`}
											>
												{option.label}
											</span>
											{option.hint && (
												<span className="text-xs text-muted-foreground truncate">
													{option.hint}
												</span>
											)}
										</label>
									))}
								</div>
							))}
						</div>
					)}
					{selected.length === 0 && (
						<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-destructive">
							<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
							<span className="text-xs font-medium">
								No {noun} selected - this key will be denied every request.
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
