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
		modelMappings: { [key: string]: string | string[] },
	) => Promise<void>;
}

function formatMappingValue(value: string | string[]): string {
	return Array.isArray(value) ? value.join(", ") : value || "";
}

function parseMappingValue(value: string): string | string[] | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parts = trimmed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.length === 1 ? parts[0] : parts;
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
				opus: formatMappingValue(account.modelMappings.opus || ""),
				sonnet: formatMappingValue(account.modelMappings.sonnet || ""),
				haiku: formatMappingValue(account.modelMappings.haiku || ""),
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
			const mappingsToSend: { [key: string]: string | string[] } = {};
			const opus = parseMappingValue(modelMappings.opus);
			const sonnet = parseMappingValue(modelMappings.sonnet);
			const haiku = parseMappingValue(modelMappings.haiku);

			if (opus) mappingsToSend.opus = opus;
			if (sonnet) mappingsToSend.sonnet = sonnet;
			if (haiku) mappingsToSend.haiku = haiku;

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
			<DialogContent className="sm:max-w-[600px] flex flex-col max-h-[85vh]">
				<DialogHeader>
					<DialogTitle>Edit Model Configuration</DialogTitle>
					<DialogDescription>
						Configure model mappings for {account.name}. Separate multiple
						models with commas to cycle through them on rate limits.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4 py-2 overflow-y-auto flex-1">
					<div>
						<h4 className="text-sm font-medium mb-2">Model Mappings</h4>
						<p className="text-xs text-muted-foreground mb-3">
							Map Anthropic model names to provider-specific models. Use commas
							for multiple models (e.g.{" "}
							<code className="text-xs bg-muted px-1 rounded">
								model-a, model-b
							</code>
							) to cycle on rate limits.
						</p>
						<div className="grid grid-cols-3 gap-3">
							<div className="space-y-1">
								<Label htmlFor="opus" className="text-xs">
									Opus
								</Label>
								<Input
									id="opus"
									value={modelMappings.opus}
									onChange={(e) => handleInputChange("opus", e.target.value)}
									placeholder={`e.g., ${LATEST_OPUS_MODEL}`}
									className="h-8"
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="sonnet" className="text-xs">
									Sonnet
								</Label>
								<Input
									id="sonnet"
									value={modelMappings.sonnet}
									onChange={(e) => handleInputChange("sonnet", e.target.value)}
									placeholder={`e.g., ${LATEST_SONNET_MODEL}`}
									className="h-8"
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="haiku" className="text-xs">
									Haiku
								</Label>
								<Input
									id="haiku"
									value={modelMappings.haiku}
									onChange={(e) => handleInputChange("haiku", e.target.value)}
									placeholder={`e.g., ${LATEST_HAIKU_MODEL}`}
									className="h-8"
								/>
							</div>
						</div>
					</div>
				</div>
				<DialogFooter className="mt-2 shrink-0">
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
