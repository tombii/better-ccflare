import { useEffect, useState } from "react";
import { useApiError } from "../../hooks/useApiError";
import {
	useCreateSearchProvider,
	useSearchProviderCatalog,
	useUpdateSearchProvider,
} from "../../hooks/useSearchProviders";
import type { SearchProviderPublic } from "../../lib/search-provider-types";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import {
	emptyFormState,
	formStateFromProvider,
	formStateToPayload,
	ProviderFormFields,
	type ProviderFormState,
	validateForm,
} from "./ProviderFormFields";

interface ProviderDialogProps {
	isOpen: boolean;
	onClose: () => void;
	/** When set, the dialog edits this provider instead of creating one. */
	provider?: SearchProviderPublic | null;
}

/**
 * Add / edit dialog for a search provider. The caller mounts it only while
 * open, so the form state (which briefly holds a freshly typed key) is
 * discarded every time it closes.
 */
export function ProviderDialog({
	isOpen,
	onClose,
	provider,
}: ProviderDialogProps) {
	const isEdit = !!provider;
	const catalogQuery = useSearchProviderCatalog();
	const catalog = catalogQuery.data ?? [];
	const create = useCreateSearchProvider();
	const update = useUpdateSearchProvider();
	const { formatError } = useApiError();
	const [form, setForm] = useState<ProviderFormState>(() =>
		provider
			? formStateFromProvider(provider)
			: emptyFormState(catalogQuery.data ?? []),
	);
	const [submitAttempted, setSubmitAttempted] = useState(false);

	const catalogEntry = catalog.find((c) => c.id === form.provider);
	// The dialog is mounted afresh for every open; dropping a stale error from a
	// previous open keeps it from showing up as if it were this attempt's.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on mount
	useEffect(() => {
		create.reset();
		update.reset();
	}, []);

	const validationError = validateForm(form, catalogEntry, { isEdit });
	const mutation = isEdit ? update : create;
	const busy = mutation.isPending;

	const handleSubmit = () => {
		setSubmitAttempted(true);
		if (validationError) return;
		const payload = formStateToPayload(form, catalogEntry);
		if (isEdit && provider) {
			update.mutate(
				{ id: provider.id, patch: payload },
				{ onSuccess: onClose },
			);
		} else {
			create.mutate(payload, { onSuccess: onClose });
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && !busy && onClose()}>
			<DialogContent className="flex max-h-[90vh] max-w-lg flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>
						{isEdit ? "Edit search provider" : "Add search provider"}
					</DialogTitle>
					<DialogDescription>
						{isEdit
							? "Update this provider's settings. Leave the API key blank to keep the stored one."
							: "Configure a provider the proxy uses to answer web-search requests."}
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 flex-1 overflow-y-auto py-2">
					{catalogQuery.isLoading && (
						<p className="text-sm text-muted-foreground">
							Loading provider types...
						</p>
					)}
					{catalogQuery.isError && (
						<p className="text-sm text-destructive">
							Could not load the provider list:{" "}
							{formatError(catalogQuery.error)}
						</p>
					)}
					{!catalogQuery.isLoading && !catalogQuery.isError && (
						<ProviderFormFields
							form={form}
							onChange={setForm}
							catalog={catalog}
							catalogEntry={catalogEntry}
							isEdit={isEdit}
						/>
					)}
				</div>

				{submitAttempted && validationError && (
					<p className="text-sm text-destructive">{validationError}</p>
				)}
				{mutation.isError && (
					<p className="text-sm text-destructive">
						Could not {isEdit ? "save" : "add"} the provider:{" "}
						{formatError(mutation.error)}
					</p>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button
						onClick={handleSubmit}
						disabled={busy || !!catalogQuery.isLoading}
					>
						{busy
							? isEdit
								? "Saving..."
								: "Adding..."
							: isEdit
								? "Save"
								: "Add provider"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
