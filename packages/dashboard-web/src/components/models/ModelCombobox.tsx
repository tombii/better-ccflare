import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useProviderModels } from "../../hooks/useProviderModels";
import {
	formatModelList,
	type ProviderModel,
	parseModelList,
} from "../../lib/model-api";
import { cn } from "../../lib/utils";
import { providerAllowsClientModelPassthrough } from "../../utils/provider-utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
	PopoverTrigger,
} from "../ui/popover";

export interface ModelComboboxProps {
	/** Provider for the target account ("anthropic", "codex", ...). Null = no list. */
	provider?: string | null;
	value: string;
	onChange: (value: string) => void;
	/**
	 * "single": the field holds one model (a combo slot).
	 * "list": the field holds a comma-separated list that rotates on rate
	 * limits (account mappings). Picking an item toggles its presence in the
	 * list instead of replacing the whole field.
	 */
	mode?: "single" | "list";
	placeholder?: string;
	id?: string;
	/** Wrapper class (use flex-1 to share the row with the test button). */
	className?: string;
	inputClassName?: string;
	disabled?: boolean;
	/**
	 * Completely hides the "use the client model" (passthrough) option from
	 * the popover, even when the provider would allow it. Used on the
	 * per-provider default-model map screen: there, an empty field means "no
	 * override", never passthrough, so the option must not appear.
	 * Defaults to false — ComboSlotBuilder and AccountModelMappingsDialog do
	 * not pass this prop, so their behavior remains unchanged.
	 */
	hideClientModelOption?: boolean;
}

interface ModelOptionProps {
	model: ProviderModel;
	picked: boolean;
	onPick: (id: string) => void;
}

function ModelOption({ model, picked, onPick }: ModelOptionProps) {
	return (
		<button
			type="button"
			onClick={() => onPick(model.id)}
			className={cn(
				"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground",
				picked && "bg-accent/60",
			)}
		>
			<Check
				className={cn(
					"h-3.5 w-3.5 shrink-0",
					picked ? "opacity-100" : "opacity-0",
				)}
			/>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-mono text-xs">{model.id}</span>
				{model.displayName !== model.id && (
					<span className="block truncate text-[11px] text-muted-foreground">
						{model.displayName}
					</span>
				)}
			</span>
		</button>
	);
}

/**
 * Passthrough option text, accurate for the target account provider.
 *
 * The old copy promised "the client model goes upstream untouched" for every
 * provider — false outside passthrough providers, and that promise caused the
 * broken slot in the incident.
 */
function clientModelHint(
	mode: "single" | "list",
	provider: string | null | undefined,
	passthroughAllowed: boolean,
): string {
	if (passthroughAllowed) {
		return mode === "list"
			? "Clears the field. With no mapping, the model requested by the client goes upstream untouched."
			: "Leaves the field empty (passthrough): the model requested by the client goes upstream untouched.";
	}
	const name = provider?.trim();
	if (!name) {
		return "Pick an account first: whether the model can be left empty depends on the provider.";
	}
	return mode === "list"
		? `Not passthrough on ${name}: with no mapping, the built-in default map of the provider decides — and it may point at a model this account cannot call.`
		: `Unavailable on ${name}: this provider does not serve Claude model ids, so an empty model would be coerced by a default map into something this account may not be able to call. Pick a model.`;
}

/**
 * Model field with a provider list.
 *
 * It remains a free-text input: a new model works before it appears in the
 * list. The list exists to reduce typing errors, not to close the set of
 * options.
 */
export function ModelCombobox({
	provider,
	value,
	onChange,
	mode = "single",
	placeholder,
	id,
	className,
	inputClassName,
	disabled,
	hideClientModelOption = false,
}: ModelComboboxProps) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const query = useProviderModels(provider);

	const selected = useMemo(() => parseModelList(value), [value]);
	const usesClientModel = value.trim().length === 0;
	const hasProvider = Boolean(provider?.trim());
	// Single rule in utils/provider-utils: an empty field only means something
	// when the upstream serves the same model IDs requested by the client.
	const passthroughAllowed = providerAllowsClientModelPassthrough(provider);
	// In mode="list", the same button CLEARs a mapping — a legitimate action
	// for every provider — so only the copy changes there. In mode="single"
	// (combo slot), an empty field would be an invalid slot: disable it and
	// explain why rather than making it disappear without explanation.
	const clientModelDisabled = mode === "single" && !passthroughAllowed;
	const clientModelTitle =
		mode === "list" && !passthroughAllowed
			? "Clear this mapping"
			: "Use the model sent by the client";

	const { known, reference } = useMemo(() => {
		const models = query.data?.models ?? [];
		const needle = filter.trim().toLowerCase();
		const matches = (model: ProviderModel) =>
			needle.length === 0 ||
			model.id.toLowerCase().includes(needle) ||
			model.displayName.toLowerCase().includes(needle);
		return {
			known: models.filter((m) => m.source !== "reference" && matches(m)),
			reference: models.filter((m) => m.source === "reference" && matches(m)),
		};
	}, [query.data, filter]);

	const isPicked = (modelId: string) =>
		mode === "list" ? selected.includes(modelId) : value.trim() === modelId;

	const handlePick = (modelId: string) => {
		if (mode === "list") {
			// The list rotates on rate limits, so choosing toggles presence instead
			// of deleting what is already there — and the popover stays open to build
			// the whole list at once.
			const next = selected.includes(modelId)
				? selected.filter((m) => m !== modelId)
				: [...selected, modelId];
			onChange(formatModelList(next));
			return;
		}
		onChange(modelId);
		setOpen(false);
	};

	const handleUseClientModel = () => {
		onChange("");
		setOpen(false);
	};

	const nothingListed =
		!query.isLoading &&
		!query.isError &&
		known.length === 0 &&
		reference.length === 0;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverAnchor asChild>
				<div className={cn("relative w-full", className)}>
					<Input
						id={id}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						placeholder={placeholder}
						disabled={disabled}
						autoComplete="off"
						spellCheck={false}
						className={cn("pr-9 font-mono text-xs", inputClassName)}
					/>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={disabled}
							aria-label="Show models for this provider"
							title="Show models for this provider"
							className="absolute right-0 top-0 h-full px-2 text-muted-foreground hover:bg-transparent hover:text-foreground"
						>
							<ChevronDown className="h-4 w-4" />
						</Button>
					</PopoverTrigger>
				</div>
			</PopoverAnchor>
			<PopoverContent
				align="start"
				portal={false}
				className="w-[max(var(--radix-popover-trigger-width),22rem)] p-0"
			>
				<div className="space-y-1 border-b p-2">
					<Input
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter models..."
						className="h-8"
					/>
					<p className="px-1 text-[11px] text-muted-foreground">
						{hasProvider
							? `Models for provider: ${provider}`
							: "No account selected yet, so there is no provider list to show."}
						{mode === "list"
							? " Click an item to add or remove it from the list."
							: ""}
					</p>
				</div>
				<div
					className="max-h-72 overflow-y-auto overscroll-contain p-1"
					onWheelCapture={(e) => e.stopPropagation()}
				>
					{!hideClientModelOption && (
						<button
							type="button"
							onClick={handleUseClientModel}
							disabled={clientModelDisabled}
							className={cn(
								"mb-1 flex w-full items-start gap-2 rounded-sm border border-dashed px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground",
								usesClientModel &&
									!clientModelDisabled &&
									"border-primary bg-accent/60",
								clientModelDisabled &&
									"cursor-not-allowed opacity-60 hover:bg-transparent hover:text-inherit",
							)}
						>
							<Check
								className={cn(
									"mt-0.5 h-3.5 w-3.5 shrink-0",
									usesClientModel && !clientModelDisabled
										? "opacity-100"
										: "opacity-0",
								)}
							/>
							<span className="min-w-0 flex-1">
								<span className="block text-sm font-medium">
									{clientModelTitle}
								</span>
								<span className="block text-[11px] text-muted-foreground">
									{clientModelHint(mode, provider, passthroughAllowed)}
								</span>
							</span>
						</button>
					)}

					{query.isLoading && (
						<div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							Loading models...
						</div>
					)}

					{query.isError && (
						<p className="px-2 py-3 text-xs text-destructive">
							Could not load the model list. Typing the model name still works.{" "}
							{query.error instanceof Error
								? query.error.message
								: "unknown error"}
						</p>
					)}

					{hasProvider && nothingListed && (
						<p className="px-2 py-3 text-xs text-muted-foreground">
							No model matched. Type the name — a brand new model works before
							it shows up here.
						</p>
					)}

					{known.length > 0 && (
						<>
							<div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
								Known to ccflare
							</div>
							{known.map((model) => (
								<ModelOption
									key={model.id}
									model={model}
									picked={isPicked(model.id)}
									onPick={handlePick}
								/>
							))}
						</>
					)}

					{reference.length > 0 && (
						<>
							<div className="flex flex-wrap items-center gap-1.5 px-2 pb-1 pt-3">
								<span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
									Provider catalog (reference)
								</span>
								<Badge variant="warning" className="px-1.5 py-0 text-[10px]">
									may not be released for this plan
								</Badge>
							</div>
							<p className="px-2 pb-1 text-[11px] text-muted-foreground">
								Listed in the public catalog of the provider. Being here is no
								proof that the plan of this account can call it: a subscription
								account still gets HTTP 400 for a model it is not entitled to.
								Use Test to find out.
							</p>
							{reference.map((model) => (
								<ModelOption
									key={model.id}
									model={model}
									picked={isPicked(model.id)}
									onPick={handlePick}
								/>
							))}
						</>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
