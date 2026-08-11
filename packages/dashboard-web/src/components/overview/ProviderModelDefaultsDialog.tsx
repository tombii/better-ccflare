import { AlertCircle, Info, Loader2, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import {
	useProviderModelDefaults,
	useSaveProviderModelDefaults,
} from "../../hooks/useProviderModelDefaults";
import type { ProviderModelDefaultOverrideInput } from "../../lib/provider-model-defaults-api";
import { ModelCombobox } from "../models/ModelCombobox";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

// Display order for known families; any future family sent by the backend that
// is unknown here goes last, alphabetically — it never disappears from the
// screen merely because it is absent from this list.
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

function familyLabel(family: string): string {
	return family.charAt(0).toUpperCase() + family.slice(1);
}

function fieldKey(provider: string, family: string): string {
	return `${provider}:${family}`;
}

function domId(provider: string, family: string): string {
	return `provider-model-default-${provider}-${family}`;
}

function sortFamilies<T extends { family: string }>(fields: T[]): T[] {
	return [...fields].sort((a, b) => {
		const ia = FAMILY_ORDER.indexOf(a.family);
		const ib = FAMILY_ORDER.indexOf(b.family);
		if (ia === -1 && ib === -1) return a.family.localeCompare(b.family);
		if (ia === -1) return 1;
		if (ib === -1) return -1;
		return ia - ib;
	});
}

/**
 * Per-provider default model map: the LAST word in the resolution chain
 * (combo slot -> account mapping -> this map embedded in code). It has a UI
 * only because one hardcoded map sent a Codex/ChatGPT account to a model its
 * subscription cannot use — and until now rebuilding was the only fix.
 *
 * Empty field == no override == use the factory value (shown in the
 * placeholder and hint below the field). This is NOT the ModelCombobox "use
 * the client model" (passthrough) option — that option is deliberately
 * hidden here with `hideClientModelOption`: this field exists specifically
 * for providers that do not speak Claude, so passthrough never makes sense
 * on this screen.
 *
 * It lives in a modal (opened from the SettingsTab "Advanced" card) because
 * it is rarely changed. One tab per provider deliberately keeps each tab
 * short (at most 4 fields): ModelCombobox renders its popover without a
 * portal (see ModelCombobox) because when portalized, Radix Dialog scroll
 * locking swallows the mouse wheel inside modals — and an `overflow-y-auto`
 * between the dialog and field would clip the dropdown list. Therefore this
 * modal does not scroll: the tabs exist to guarantee that, not just to organize.
 */
export function ProviderModelDefaultsDialog() {
	const query = useProviderModelDefaults();
	const save = useSaveProviderModelDefaults();
	// Local draft per field (key `${provider}:${family}`). It becomes a real
	// override only when the user clicks Save — nothing here saves on every
	// keystroke.
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [activeTab, setActiveTab] = useState<string | undefined>(undefined);

	// Resynchronizes the draft whenever the query brings a fresh server
	// snapshot: on initial load and after Save invalidates the query. An empty
	// override in the draft means "no customization; use the factory value".
	useEffect(() => {
		if (!query.data) return;
		const next: Record<string, string> = {};
		for (const provider of query.data) {
			for (const field of provider.fields) {
				next[fieldKey(provider.provider, field.family)] = field.override ?? "";
			}
		}
		setDrafts(next);
	}, [query.data]);

	const providers = query.data ?? [];
	const sortedProviders = [...providers].sort((a, b) =>
		a.provider.localeCompare(b.provider),
	);

	// Keeps the active tab valid as providers arrive or change; selects the
	// first one by default once the list arrives.
	useEffect(() => {
		if (sortedProviders.length === 0) return;
		if (
			activeTab &&
			sortedProviders.some((provider) => provider.provider === activeTab)
		) {
			return;
		}
		setActiveTab(sortedProviders[0].provider);
	}, [sortedProviders, activeTab]);

	const handleChange = (provider: string, family: string, value: string) => {
		setDrafts((prev) => ({ ...prev, [fieldKey(provider, family)]: value }));
	};

	const handleReset = (provider: string, family: string) => {
		setDrafts((prev) => ({ ...prev, [fieldKey(provider, family)]: "" }));
	};

	// Derived on every render: fields whose drafts differ from what is saved
	// now. It is also the Save payload — no parallel "dirty" state can drift
	// from what will actually be sent. It runs over ALL providers, not only
	// the active tab: Save applies to the entire modal.
	const dirtyOverrides: ProviderModelDefaultOverrideInput[] = [];
	for (const provider of providers) {
		for (const field of provider.fields) {
			const key = fieldKey(provider.provider, field.family);
			const draft = (drafts[key] ?? "").trim();
			const saved = field.override ?? "";
			if (draft !== saved) {
				dirtyOverrides.push({
					provider: provider.provider,
					family: field.family,
					model: draft,
				});
			}
		}
	}

	const handleSave = () => {
		if (dirtyOverrides.length === 0) return;
		save.mutate(dirtyOverrides);
	};

	const disableFields = query.isLoading || save.isPending;

	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					Configure
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Provider Model Defaults</DialogTitle>
					<DialogDescription>
						The built-in model this proxy falls back to per provider and Claude
						family, for providers that do not speak Claude model ids natively.
					</DialogDescription>
				</DialogHeader>

				<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
					<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					Last resort in the routing chain: only used when the requested model
					has no slot in the combo and no mapping on the account.
				</p>

				{query.isLoading && (
					<div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Loading provider defaults...
					</div>
				)}

				{query.isError && (
					<p className="flex items-center gap-2 py-2 text-sm text-destructive">
						<AlertCircle className="h-4 w-4 shrink-0" />
						Could not load provider defaults.{" "}
						{query.error instanceof Error
							? query.error.message
							: "unknown error"}
					</p>
				)}

				{!query.isLoading && !query.isError && sortedProviders.length === 0 && (
					<p className="py-2 text-sm text-muted-foreground">
						No provider has a built-in default map to configure.
					</p>
				)}

				{sortedProviders.length > 0 && activeTab && (
					<Tabs value={activeTab} onValueChange={setActiveTab}>
						<TabsList>
							{sortedProviders.map((provider) => (
								<TabsTrigger key={provider.provider} value={provider.provider}>
									{provider.provider}
								</TabsTrigger>
							))}
						</TabsList>
						{sortedProviders.map((provider) => (
							<TabsContent
								key={provider.provider}
								value={provider.provider}
								className="grid grid-cols-1 gap-3 sm:grid-cols-2"
							>
								{sortFamilies(provider.fields).map((field) => {
									const key = fieldKey(provider.provider, field.family);
									const id = domId(provider.provider, field.family);
									const draft = drafts[key] ?? "";
									const customized = draft.trim().length > 0;
									return (
										<div key={key} className="space-y-1">
											<Label htmlFor={id} className="text-xs">
												{familyLabel(field.family)}
											</Label>
											<div className="flex items-center gap-1.5">
												<ModelCombobox
													id={id}
													provider={provider.provider}
													value={draft}
													onChange={(value) =>
														handleChange(provider.provider, field.family, value)
													}
													placeholder={`${field.factory} (factory)`}
													hideClientModelOption
													className="flex-1"
													inputClassName="h-8"
													disabled={disableFields}
												/>
												{customized && (
													<Button
														type="button"
														variant="ghost"
														size="sm"
														title={`Reset to factory: ${field.factory}`}
														onClick={() =>
															handleReset(provider.provider, field.family)
														}
														disabled={save.isPending}
													>
														<RefreshCw className="h-3.5 w-3.5" />
													</Button>
												)}
											</div>
											<p className="text-[11px] text-muted-foreground">
												{customized
													? `Customized. Factory: ${field.factory}`
													: `Factory: ${field.factory}`}
											</p>
										</div>
									);
								})}
							</TabsContent>
						))}
					</Tabs>
				)}

				<div className="flex items-center gap-2 pt-1">
					<Button
						size="sm"
						onClick={handleSave}
						disabled={
							dirtyOverrides.length === 0 || save.isPending || query.isLoading
						}
					>
						{save.isPending ? (
							<>
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
								Saving...
							</>
						) : (
							<>
								<Save className="h-3.5 w-3.5" />
								Save
							</>
						)}
					</Button>
					{dirtyOverrides.length > 0 && !save.isPending && (
						<span className="text-xs text-muted-foreground">
							{dirtyOverrides.length} field
							{dirtyOverrides.length === 1 ? "" : "s"} changed
						</span>
					)}
				</div>

				{save.isError && (
					<p className="flex items-center gap-2 text-xs text-destructive">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						Could not save.{" "}
						{save.error instanceof Error ? save.error.message : "unknown error"}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
