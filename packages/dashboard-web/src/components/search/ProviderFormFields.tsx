import type { SearchProviderTier } from "@better-ccflare/types";
import { ExternalLink } from "lucide-react";
import type {
	CreateSearchProviderInput,
	SearchProviderCatalogEntry,
	SearchProviderPublic,
} from "../../lib/search-provider-types";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

/**
 * Shared form state for the add and edit dialogs. It holds the raw API key in
 * component state only for as long as the dialog is open; it is never read
 * back from the server (which only ever returns `apiKeyMasked`).
 */
export interface ProviderFormState {
	provider: string;
	label: string;
	apiKey: string;
	priority: string;
	maxResults: string;
	extraConfig: Record<string, string>;
	/** Edit only: the operator asked to clear the stored key (switch to free). */
	clearKey?: boolean;
}

export function emptyFormState(
	catalog: SearchProviderCatalogEntry[],
): ProviderFormState {
	const first = catalog[0];
	return {
		provider: first?.id ?? "",
		label: first?.label ?? "",
		apiKey: "",
		priority: "0",
		maxResults: "5",
		extraConfig: {},
	};
}

export function formStateFromProvider(
	provider: SearchProviderPublic,
): ProviderFormState {
	const extraConfig: Record<string, string> = {};
	for (const [key, value] of Object.entries(provider.extraConfig ?? {})) {
		if (value === null || value === undefined) continue;
		extraConfig[key] = String(value);
	}
	return {
		provider: provider.provider,
		label: provider.label,
		apiKey: "",
		priority: String(provider.priority),
		maxResults: String(provider.maxResults),
		extraConfig,
	};
}

// Bounds must match the server's validation in
// packages/http-api/src/handlers/search-providers.ts — anything looser lets
// the form submit values the API rejects.
const LABEL_MAX_LENGTH = 64;
const PRIORITY_MAX = 1000;
const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 50;

/** Whole, non-negative decimal only — rejects "12.7", "3abc" and negatives. */
function parseWholeNumber(raw: string): number | null {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const value = Number(trimmed);
	return Number.isSafeInteger(value) ? value : null;
}

/**
 * Which endpoint the edited row would use after saving. The key field is
 * blank on every edit (the stored key is never sent to the browser), so a
 * blank field with a stored key stays paid; an explicit clear switches to
 * free. Mirrors the server's derivation.
 */
export function formTier(
	form: ProviderFormState,
	catalogEntry: SearchProviderCatalogEntry | undefined,
	options: { isEdit: boolean; hasStoredKey: boolean },
): SearchProviderTier {
	const typed = form.apiKey.trim();
	if (typed) return "paid";
	// "Clear the stored key" is only offered for rows that can actually go
	// keyless; honouring it here keeps the preview equal to what is saved.
	const clearing =
		form.clearKey === true && catalogEntry?.requiresKey === false;
	if (options.isEdit && options.hasStoredKey && !clearing) return "paid";
	return catalogEntry?.requiresKey === false ? "free" : "paid";
}

/** Returns an error message, or null when the form may be submitted. */
export function validateForm(
	form: ProviderFormState,
	catalogEntry: SearchProviderCatalogEntry | undefined,
	options: { isEdit: boolean; hasStoredKey?: boolean },
): string | null {
	if (!form.provider) return "Choose a provider.";
	if (!form.label.trim()) return "Give the provider a label.";
	if (form.label.trim().length > LABEL_MAX_LENGTH)
		return `Label must be at most ${LABEL_MAX_LENGTH} characters.`;
	const priority = parseWholeNumber(form.priority);
	if (priority === null || priority > PRIORITY_MAX)
		return `Priority must be a whole number between 0 and ${PRIORITY_MAX}.`;
	const maxResults = parseWholeNumber(form.maxResults);
	if (
		maxResults === null ||
		maxResults < MAX_RESULTS_MIN ||
		maxResults > MAX_RESULTS_MAX
	)
		return `Max results must be a whole number between ${MAX_RESULTS_MIN} and ${MAX_RESULTS_MAX}.`;
	// Editing: leaving the key blank keeps the stored one.
	if (catalogEntry?.requiresKey && !options.isEdit && !form.apiKey.trim())
		return "This provider needs an API key.";
	// An edit that clears the only key of a paid-only provider would leave it
	// unable to search at all.
	if (
		options.isEdit &&
		catalogEntry?.requiresKey &&
		!form.apiKey.trim() &&
		options.hasStoredKey === true &&
		form.clearKey
	)
		return "This provider needs an API key, so it cannot be cleared.";
	return null;
}

export function ProviderFormFields({
	form,
	onChange,
	catalog,
	catalogEntry,
	isEdit,
	hasStoredKey = false,
}: {
	form: ProviderFormState;
	onChange: (next: ProviderFormState) => void;
	catalog: SearchProviderCatalogEntry[];
	catalogEntry: SearchProviderCatalogEntry | undefined;
	isEdit: boolean;
	/** Edit only: the row has a stored key (shown masked in the list). */
	hasStoredKey?: boolean;
}) {
	const set = (patch: Partial<ProviderFormState>) =>
		onChange({ ...form, ...patch });

	const setExtra = (key: string, value: string) =>
		onChange({
			...form,
			extraConfig: { ...form.extraConfig, [key]: value },
		});

	const handleProviderChange = (providerId: string) => {
		const entry = catalog.find((c) => c.id === providerId);
		// Prefill the label with the catalog name only when the label is still
		// blank or still equals the previous catalog name (i.e. the user has
		// not customised it).
		const previousLabel = catalog.find((c) => c.id === form.provider)?.label;
		const label =
			!form.label.trim() || form.label === previousLabel
				? (entry?.label ?? form.label)
				: form.label;
		// Options belong to the previous provider kind, so they reset.
		set({ provider: providerId, label, extraConfig: {} });
	};

	const keyRequired = catalogEntry?.requiresKey ?? true;

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="search-provider-kind">Provider</Label>
				<Select
					value={form.provider}
					onValueChange={handleProviderChange}
					disabled={isEdit}
				>
					<SelectTrigger id="search-provider-kind">
						<SelectValue placeholder="Select a provider..." />
					</SelectTrigger>
					<SelectContent>
						{catalog.map((entry) => (
							<SelectItem key={entry.id} value={entry.id}>
								{entry.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{catalogEntry?.docsUrl && (
					<a
						href={catalogEntry.docsUrl}
						target="_blank"
						rel="noreferrer noopener"
						className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
					>
						Provider documentation
						<ExternalLink className="h-3 w-3" />
					</a>
				)}
			</div>

			<div className="space-y-2">
				<Label htmlFor="search-provider-label">Label</Label>
				<Input
					id="search-provider-label"
					value={form.label}
					placeholder={catalogEntry?.label ?? "My provider"}
					onChange={(e) => set({ label: e.target.value })}
					maxLength={100}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="search-provider-api-key">
					API key{keyRequired ? "" : " (optional)"}
				</Label>
				<Input
					id="search-provider-api-key"
					type="password"
					autoComplete="new-password"
					value={form.apiKey}
					placeholder={
						isEdit
							? hasStoredKey
								? "Leave blank to keep the stored key"
								: "Paste a key for the paid tier"
							: "Paste a key for the paid tier"
					}
					onChange={(e) => set({ apiKey: e.target.value })}
				/>
				<p className="text-xs text-muted-foreground">
					{keyRequired
						? "Stored by the proxy; it is only ever shown masked after saving."
						: isEdit && hasStoredKey
							? "Leave blank to keep the stored key (paid searches). Stored by the proxy; it is only ever shown masked after saving."
							: "Leave blank to use this provider's free (keyless) endpoint, which is rate-limited and may refuse this host's address. Add a key for paid searches."}
				</p>
				{isEdit && hasStoredKey && (
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={form.clearKey === true}
							onChange={(e) => set({ clearKey: e.target.checked })}
						/>
						Clear the stored key and switch this row to Free
					</label>
				)}
			</div>

			{catalogEntry?.keyless && (
				<p className="text-xs text-muted-foreground">
					Tier after saving:{" "}
					<span className="font-medium">
						{formTier(form, catalogEntry, { isEdit, hasStoredKey }) === "free"
							? "Free (keyless)"
							: "Paid (keyed)"}
					</span>
					. Free rows are switched by the "Use free tier" toggle.
				</p>
			)}

			<div className="grid grid-cols-2 gap-4">
				<div className="space-y-2">
					<Label htmlFor="search-provider-priority">Priority</Label>
					<Input
						id="search-provider-priority"
						type="number"
						min={0}
						value={form.priority}
						onChange={(e) => set({ priority: e.target.value })}
					/>
					<p className="text-xs text-muted-foreground">
						Lower numbers are tried first.
					</p>
				</div>
				<div className="space-y-2">
					<Label htmlFor="search-provider-max-results">Max results</Label>
					<Input
						id="search-provider-max-results"
						type="number"
						min={1}
						value={form.maxResults}
						onChange={(e) => set({ maxResults: e.target.value })}
					/>
				</div>
			</div>

			{catalogEntry?.extraConfigFields &&
				catalogEntry.extraConfigFields.length > 0 && (
					<div className="space-y-3 rounded-md border p-3">
						<p className="text-sm font-medium">Provider options</p>
						{catalogEntry.extraConfigFields.map((field) => {
							const id = `search-provider-extra-${field.key}`;
							const value = form.extraConfig[field.key] ?? "";
							return (
								<div key={field.key} className="space-y-1.5">
									<Label htmlFor={id} className="text-xs">
										{field.label}
									</Label>
									{field.type === "select" && field.options ? (
										<Select
											value={value}
											onValueChange={(v) => setExtra(field.key, v)}
										>
											<SelectTrigger id={id}>
												<SelectValue placeholder="Select..." />
											</SelectTrigger>
											<SelectContent>
												{field.options.map((option) => (
													<SelectItem key={option} value={option}>
														{option}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									) : (
										<Input
											id={id}
											type={field.type === "number" ? "number" : "text"}
											value={value}
											onChange={(e) => setExtra(field.key, e.target.value)}
										/>
									)}
								</div>
							);
						})}
					</div>
				)}
		</div>
	);
}

/**
 * Turns form state into the API payload. Blank optional values are omitted so
 * the server keeps its defaults; `extraConfig` numbers are sent as numbers.
 */
export function formStateToPayload(
	form: ProviderFormState,
	catalogEntry: SearchProviderCatalogEntry | undefined,
) {
	const apiKeyClearable = catalogEntry?.requiresKey === false;
	const extra: Record<string, unknown> = {};
	for (const field of catalogEntry?.extraConfigFields ?? []) {
		const raw = form.extraConfig[field.key];
		if (raw === undefined || raw.trim() === "") continue;
		if (field.type === "number") {
			const parsed = Number(raw);
			if (Number.isFinite(parsed)) extra[field.key] = parsed;
		} else {
			extra[field.key] = raw;
		}
	}
	// A cleared key is sent as "" so the server drops it. A typed key always
	// wins over a stale clear checkbox.
	const typedKey = form.apiKey.trim();
	const apiKey = typedKey
		? typedKey
		: form.clearKey === true && apiKeyClearable
			? ""
			: undefined;
	return {
		provider: form.provider as CreateSearchProviderInput["provider"],
		label: form.label.trim(),
		apiKey,
		priority: Number.parseInt(form.priority, 10),
		maxResults: Number.parseInt(form.maxResults, 10),
		extraConfig: Object.keys(extra).length > 0 ? extra : null,
	};
}
