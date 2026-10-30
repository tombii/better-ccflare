import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { useApiError } from "../../hooks/useApiError";
import { useDeleteSearchProvider } from "../../hooks/useSearchProviders";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Delete confirmation for a search provider. Same "type the name to confirm"
 * pattern as removing an account, in the Dialog primitive (the accounts one is
 * a bespoke overlay).
 */
export function DeleteProviderDialog({
	provider,
	catalogLabel,
	isOpen,
	onClose,
}: {
	provider: SearchProviderPublic;
	catalogLabel?: string;
	isOpen: boolean;
	onClose: () => void;
}) {
	const [confirmInput, setConfirmInput] = useState("");
	const deleteProvider = useDeleteSearchProvider();
	const { formatError } = useApiError();
	const name = provider.label;

	const handleClose = () => {
		if (deleteProvider.isPending) return;
		setConfirmInput("");
		deleteProvider.reset();
		onClose();
	};

	const handleConfirm = () => {
		deleteProvider.mutate(provider.id, {
			onSuccess: () => handleClose(),
		});
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Remove search provider</DialogTitle>
					<DialogDescription>This action cannot be undone.</DialogDescription>
				</DialogHeader>

				<div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4">
					<div className="flex items-center gap-2 text-destructive">
						<AlertCircle className="h-5 w-5" />
						<p className="font-medium">Warning</p>
					</div>
					<p className="mt-2 text-sm">
						You are about to remove{" "}
						<strong>{catalogLabel ?? provider.provider}</strong> '
						{provider.label}' and its stored API key. Requests that relied on it
						will fall through to the next provider.
					</p>
				</div>

				<div className="space-y-2">
					<Label htmlFor={`confirm-delete-provider-${provider.id}`}>
						Type <span className="font-mono font-semibold">{name}</span> to
						confirm:
					</Label>
					<Input
						id={`confirm-delete-provider-${provider.id}`}
						value={confirmInput}
						onChange={(e) => setConfirmInput(e.target.value)}
						placeholder="Enter provider label"
						autoComplete="off"
					/>
				</div>

				{deleteProvider.isError && (
					<p className="text-sm text-destructive">
						Could not remove the provider: {formatError(deleteProvider.error)}
					</p>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={handleClose}
						disabled={deleteProvider.isPending}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={handleConfirm}
						disabled={confirmInput !== name || deleteProvider.isPending}
					>
						{deleteProvider.isPending ? "Removing..." : "Remove provider"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
