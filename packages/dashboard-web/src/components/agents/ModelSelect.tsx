import {
	AGENT_DEFAULT_MODEL_SENTINEL,
	useModelOptions,
} from "../../hooks/queries";
import { Badge } from "../ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface ModelSelectDefaultItem {
	label: string;
	/** Omit to render the default item without a badge. */
	badgeLabel?: string;
}

interface ModelSelectProps {
	value?: string;
	onValueChange: (value: string) => void;
	disabled?: boolean;
	placeholder?: string;
	triggerClassName?: string;
	/**
	 * When provided, renders a first SelectItem for
	 * `AGENT_DEFAULT_MODEL_SENTINEL` — the "leave unset / fall back to
	 * default" option. Omit this when the caller requires a concrete model
	 * value (e.g. saving agent frontmatter).
	 */
	defaultItem?: ModelSelectDefaultItem;
}

/**
 * Shared model dropdown: catalog options sourced from `useModelOptions`
 * (live Anthropic model list, falling back to the bundled static list),
 * each tagged with a "Premium" badge when its id contains "opus". This is
 * the single source of truth for model selects across the Agents UI.
 */
export function ModelSelect({
	value,
	onValueChange,
	disabled,
	placeholder,
	triggerClassName,
	defaultItem,
}: ModelSelectProps) {
	const modelOptions = useModelOptions();

	return (
		<Select value={value} onValueChange={onValueChange} disabled={disabled}>
			<SelectTrigger className={triggerClassName}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{defaultItem && (
					<SelectItem
						value={AGENT_DEFAULT_MODEL_SENTINEL}
						className="flex items-center"
					>
						<span className="flex items-center gap-2">
							<span className="text-muted-foreground">{defaultItem.label}</span>
							{defaultItem.badgeLabel && (
								<Badge variant="outline" className="text-xs">
									{defaultItem.badgeLabel}
								</Badge>
							)}
						</span>
					</SelectItem>
				)}
				{modelOptions.map((model) => (
					<SelectItem
						key={model.id}
						value={model.id}
						className="flex items-center"
					>
						<span className="flex items-center gap-2">
							{model.displayName}
							{model.id.includes("opus") && (
								<Badge variant="secondary" className="text-xs">
									Premium
								</Badge>
							)}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
