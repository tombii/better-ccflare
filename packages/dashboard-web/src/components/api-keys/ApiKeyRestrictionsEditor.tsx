import { type ApiKeyRestrictions, PROVIDER_NAMES } from "@better-ccflare/types";
import { useMemo } from "react";
import { useAccounts, useModelOptions } from "../../hooks/queries";
import { useModelPrices } from "../../hooks/useModelPrices";
import { priceSummary } from "../../lib/model-prices";
import {
	RestrictionMultiSelect,
	type RestrictionOption,
	type RestrictionOptionGroup,
} from "./RestrictionMultiSelect";
import { accountLabel, MODEL_FAMILIES } from "./restrictions";

export interface ApiKeyRestrictionsEditorProps {
	value: ApiKeyRestrictions;
	onChange: (next: ApiKeyRestrictions) => void;
	/** Prefix for input ids - two editors can be mounted at once (create + edit). */
	idPrefix: string;
	disabled?: boolean;
}

/**
 * Append the values a key already holds that are not in the offered list.
 *
 * Without this a restriction pointing at a deleted account (or a model the
 * catalog no longer lists) would have no checkbox at all: the user could see
 * it in the summary but never untick it, and any save from this editor would
 * silently drop it.
 */
function withDangling(
	known: RestrictionOption[],
	selected: string[] | null,
	label: (value: string) => string,
): RestrictionOption[] {
	if (!selected || selected.length === 0) return known;
	const seen = new Set(known.map((option) => option.value));
	const dangling = selected
		.filter((value) => !seen.has(value))
		.map((value) => ({ value, label: label(value), unknown: true }));
	return dangling.length > 0 ? [...known, ...dangling] : known;
}

/**
 * The three restriction lists of an API key.
 *
 * Shared by the create dialog and the per-key edit dialog so the two can never
 * disagree about what null means.
 */
export function ApiKeyRestrictionsEditor({
	value,
	onChange,
	idPrefix,
	disabled,
}: ApiKeyRestrictionsEditorProps) {
	const { data: accounts } = useAccounts();
	// Catalog-wide list: /api/models without a provider. The per-provider
	// endpoint behind ModelCombobox needs a provider (and ideally an account)
	// to scope the list, and a key restriction spans every account, so there is
	// no provider to scope it by here.
	const modelOptions = useModelOptions();
	const { data: prices, isLoading: pricesLoading } = useModelPrices();

	const accountGroups = useMemo<RestrictionOptionGroup[]>(() => {
		const known = accounts ?? [];
		const names = new Map(known.map((account) => [account.id, account.name]));
		const options: RestrictionOption[] = known.map((account) => ({
			value: account.id,
			label: account.name,
			hint: account.provider,
		}));
		return [
			{
				options: withDangling(options, value.allowedAccounts, (id) =>
					accountLabel(id, names),
				),
			},
		];
	}, [accounts, value.allowedAccounts]);

	const modelGroups = useMemo<RestrictionOptionGroup[]>(() => {
		const catalog: RestrictionOption[] = modelOptions.map((model) => ({
			value: model.id,
			label: model.id,
			hint: pricesLoading
				? "Loading model prices…"
				: priceSummary(prices?.models ?? [], model.id),
		}));
		const families: RestrictionOption[] = MODEL_FAMILIES.map((family) => ({
			value: family,
			label: family,
			hint: pricesLoading
				? "Loading model prices…"
				: priceSummary(prices?.models ?? [], family),
		}));
		const familyValues = new Set<string>(MODEL_FAMILIES);
		// A family already listed above must not reappear as a dangling model.
		const stillSelected =
			value.allowedModels?.filter((model) => !familyValues.has(model)) ?? null;
		return [
			{ label: "Families", options: families },
			{
				label: "Models",
				options: withDangling(catalog, stillSelected, (model) => model),
			},
		];
	}, [modelOptions, value.allowedModels, prices, pricesLoading]);

	const providerGroups = useMemo<RestrictionOptionGroup[]>(() => {
		const options: RestrictionOption[] = Object.values(PROVIDER_NAMES).map(
			(provider) => ({ value: provider, label: provider }),
		);
		return [
			{
				options: withDangling(
					options,
					value.allowedProviders,
					(provider) => provider,
				),
			},
		];
	}, [value.allowedProviders]);

	return (
		<div className="space-y-4">
			<p className="text-xs text-muted-foreground">
				Leave a switch off to allow everything in that category. Turning one on
				with nothing ticked denies every request.
			</p>
			<RestrictionMultiSelect
				id={`${idPrefix}-accounts`}
				title="Accounts"
				noun="account"
				groups={accountGroups}
				value={value.allowedAccounts}
				onChange={(allowedAccounts) => onChange({ ...value, allowedAccounts })}
				disabled={disabled}
				emptyHint="No accounts are configured yet."
			/>
			<RestrictionMultiSelect
				id={`${idPrefix}-models`}
				title="Models"
				noun="model"
				groups={modelGroups}
				value={value.allowedModels}
				onChange={(allowedModels) => onChange({ ...value, allowedModels })}
				disabled={disabled}
			/>
			<RestrictionMultiSelect
				id={`${idPrefix}-providers`}
				title="Providers"
				noun="provider"
				groups={providerGroups}
				value={value.allowedProviders}
				onChange={(allowedProviders) =>
					onChange({ ...value, allowedProviders })
				}
				disabled={disabled}
			/>
		</div>
	);
}
