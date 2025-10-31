import { useEffect, useState } from "react";
import { getDefaultEndpointForProvider } from "../../utils/provider-utils";
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

interface AccountCustomEndpointDialogProps {
	isOpen: boolean;
	account: {
		id: string;
		name: string;
		provider: string;
		customEndpoint: string | null;
	} | null;
	onOpenChange: (open: boolean) => void;
	onUpdateEndpoint: (
		accountId: string,
		customEndpoint: string | null,
	) => Promise<void>;
	isLoading?: boolean;
}

export function AccountCustomEndpointDialog({
	isOpen,
	account,
	onOpenChange,
	onUpdateEndpoint,
	isLoading = false,
}: AccountCustomEndpointDialogProps) {
	const [customEndpoint, setCustomEndpoint] = useState("");
	const [error, setError] = useState<string | null>(null);

	// Initialize custom endpoint when dialog opens or account changes
	useEffect(() => {
		if (isOpen && account) {
			setCustomEndpoint(account.customEndpoint || "");
		} else if (!isOpen) {
			// Reset when dialog closes
			setCustomEndpoint("");
			setError(null);
		}
	}, [isOpen, account]);

	const validateEndpoint = (endpoint: string): boolean => {
		if (!endpoint) return true; // Empty is fine (use default)
		try {
			new URL(endpoint);
			return true;
		} catch {
			return false;
		}
	};

	const handleSave = async () => {
		if (!account) return;

		if (customEndpoint && !validateEndpoint(customEndpoint)) {
			setError(
				"Custom endpoint must be a valid URL (e.g., https://api.anthropic.com)",
			);
			return;
		}

		setError(null);
		try {
			await onUpdateEndpoint(account.id, customEndpoint.trim() || null);
			onOpenChange(false);
			setCustomEndpoint("");
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update custom endpoint",
			);
		}
	};

	const defaultPlaceholder = account?.provider
		? getDefaultEndpointForProvider(account.provider)
		: "https://api.anthropic.com";

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Custom Endpoint</DialogTitle>
					<DialogDescription>
						Configure a custom API endpoint for{" "}
						<span className="font-medium">{account?.name}</span>
						{account?.provider && (
							<span className="text-muted-foreground">
								{" "}
								(Provider: {account.provider})
							</span>
						)}
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid gap-2">
						<Label htmlFor="customEndpoint">Custom Endpoint</Label>
						<Input
							id="customEndpoint"
							value={customEndpoint}
							onChange={(e) => {
								setCustomEndpoint(e.target.value);
								setError(null);
							}}
							placeholder={defaultPlaceholder}
							className={error ? "border-red-500" : ""}
						/>
						<p className="text-xs text-muted-foreground">
							Leave empty to use default endpoint ({defaultPlaceholder})
						</p>
						{error && <p className="text-xs text-red-500">{error}</p>}
					</div>
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isLoading}
					>
						Cancel
					</Button>
					<Button type="button" onClick={handleSave} disabled={isLoading}>
						{isLoading ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
