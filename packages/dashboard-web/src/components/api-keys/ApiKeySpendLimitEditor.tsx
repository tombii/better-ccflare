import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	ENFORCEMENT_OPTIONS,
	SPEND_WINDOW_OPTIONS,
	type SpendLimitDraft,
} from "./spend-limit";

export interface ApiKeySpendLimitEditorProps {
	value: SpendLimitDraft;
	onChange: (next: SpendLimitDraft) => void;
	/** Prefix for input ids — two editors can be mounted at once (create + edit). */
	idPrefix: string;
	disabled?: boolean;
}

/**
 * The spend limit of an API key: amount, window, and what happens on overage.
 *
 * Shared by the create dialog and the per-key edit dialog, the same way
 * ApiKeyRestrictionsEditor is, so the two can never disagree about what an
 * empty amount means.
 *
 * The amount is held as TEXT, not a number. A controlled numeric input that
 * round-trips through Number() eats a half-typed "1." and a leading ".", which
 * makes typing "0.50" genuinely difficult. `serializeSpendLimit` does the
 * parsing once, at save.
 *
 * The window and enforcement selects stay enabled with the amount empty, and
 * deliberately so: an operator who is about to type an amount can set the
 * window first, and disabling them would make the form feel broken.
 */
export function ApiKeySpendLimitEditor({
	value,
	onChange,
	idPrefix,
	disabled,
}: ApiKeySpendLimitEditorProps) {
	const hasLimit = value.limitUsd.trim() !== "";

	return (
		<div className="space-y-3">
			<CostTrackingNotice limits />
			<div className="space-y-1">
				{["fable", "opus", "sonnet", "haiku"].map((family) => (
					<div key={family}>
						<span className="text-xs font-medium capitalize">{family}</span>
						<ModelPriceHint scope={family} />
					</div>
				))}
			</div>
			<div className="space-y-2">
				<Label htmlFor={`${idPrefix}-limit-usd`}>Spend limit (USD)</Label>
				<Input
					id={`${idPrefix}-limit-usd`}
					inputMode="decimal"
					placeholder="Leave empty for no limit"
					value={value.limitUsd}
					disabled={disabled}
					onChange={(e) => onChange({ ...value, limitUsd: e.target.value })}
				/>
				<p className="text-xs text-muted-foreground">
					Measured in API-cost-equivalent dollars — the same figure the
					dashboard reports as request cost, for subscription and pay-per-token
					accounts alike.
				</p>
			</div>

			<div className="space-y-2">
				<Label htmlFor={`${idPrefix}-limit-window`}>Window</Label>
				<Select
					value={value.limitWindow}
					disabled={disabled}
					onValueChange={(next) =>
						onChange({
							...value,
							limitWindow: next as SpendLimitDraft["limitWindow"],
						})
					}
				>
					<SelectTrigger id={`${idPrefix}-limit-window`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{SPEND_WINDOW_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-2">
				<Label htmlFor={`${idPrefix}-limit-enforce`}>Over the limit</Label>
				<Select
					value={value.limitEnforce}
					disabled={disabled}
					onValueChange={(next) =>
						onChange({
							...value,
							limitEnforce: next as SpendLimitDraft["limitEnforce"],
						})
					}
				>
					<SelectTrigger id={`${idPrefix}-limit-enforce`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{ENFORCEMENT_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-xs text-muted-foreground">
					{value.limitEnforce === "warn"
						? "Requests are still served. The overage shows on the key's gauge and raises an alert."
						: "Requests are refused with a 429 until the window moves on."}
				</p>
			</div>

			{hasLimit ? (
				<p className="text-xs text-muted-foreground">
					A request's cost is only known once it finishes, so a key can pass its
					limit by roughly one in-flight request.
				</p>
			) : null}
		</div>
	);
}

import { CostTrackingNotice } from "../CostTrackingNotice";
import { ModelPriceHint } from "../ModelPricesTab";
