import {
	LATEST_HAIKU_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
} from "@better-ccflare/core";
import React, { useState } from "react";
import type { Account } from "../../api";
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

interface AccountModelMappingsDialogProps {
	isOpen: boolean;
	account: Account | null;
	onOpenChange: (open: boolean) => void;
	onUpdateModelMappings: (
		accountId: string,
		modelMappings: { [key: string]: string },
	) => Promise<void>;
}

export function AccountModelMappingsDialog({
	isOpen,
	account,
	onOpenChange,
	onUpdateModelMappings,
}: AccountModelMappingsDialogProps) {
	const [modelMappings, setModelMappings] = useState<{
		opus: string;
		sonnet: string;
		haiku: string;
	}>({
		opus: "",
		sonnet: "",
		haiku: "",
	});
	const [isLoading, setIsLoading] = useState(false);

	// Update form when account changes
	React.useEffect(() => {
		if (account?.modelMappings) {
			setModelMappings({
				opus: account.modelMappings.opus || "",
				sonnet: account.modelMappings.sonnet || "",
				haiku: account.modelMappings.haiku || "",
			});
		} else {
			setModelMappings({
				opus: "",
				sonnet: "",
				haiku: "",
			});
		}
	}, [account]);

	const handleSave = async () => {
		if (!account) return;

		setIsLoading(true);
		try {
			// Only include non-empty mappings
			const mappingsToSend: { [key: string]: string } = {};
			if (modelMappings.opus.trim()) {
				mappingsToSend.opus = modelMappings.opus.trim();
			}
			if (modelMappings.sonnet.trim()) {
				mappingsToSend.sonnet = modelMappings.sonnet.trim();
			}
			if (modelMappings.haiku.trim()) {
				mappingsToSend.haiku = modelMappings.haiku.trim();
			}

			await onUpdateModelMappings(account.id, mappingsToSend);
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to update model mappings:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const handleInputChange = (
		modelType: "opus" | "sonnet" | "haiku",
		value: string,
	) => {
		setModelMappings((prev) => ({
			...prev,
			[modelType]: value,
		}));
	};

	if (!account) return null;

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Edit Model Mappings</DialogTitle>
					<DialogDescription>
						Configure model aliases for {account.name}. Map Anthropic model
						names to provider-specific models.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<div className="space-y-2">
						<Label htmlFor="opus">Opus Model</Label>
						<Input
							id="opus"
							value={modelMappings.opus}
							onChange={(e) => handleInputChange("opus", e.target.value)}
							placeholder={`e.g., anthropic/${LATEST_OPUS_MODEL}`}
						/>
						<p className="text-xs text-muted-foreground">
							Model to use when Claude requests Opus. Leave empty to use
							provider default.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="sonnet">Sonnet Model</Label>
						<Input
							id="sonnet"
							value={modelMappings.sonnet}
							onChange={(e) => handleInputChange("sonnet", e.target.value)}
							placeholder={`e.g., anthropic/${LATEST_SONNET_MODEL}`}
						/>
						<p className="text-xs text-muted-foreground">
							Model to use when Claude requests Sonnet. Leave empty to use
							provider default.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="haiku">Haiku Model</Label>
						<Input
							id="haiku"
							value={modelMappings.haiku}
							onChange={(e) => handleInputChange("haiku", e.target.value)}
							placeholder={`e.g., anthropic/${LATEST_HAIKU_MODEL}`}
						/>
						<p className="text-xs text-muted-foreground">
							Model to use when Claude requests Haiku. Leave empty to use
							provider default.
						</p>
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
						{isLoading ? "Saving..." : "Save Changes"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
