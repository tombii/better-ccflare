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
	onUpdateModelFallbacks?: (
		accountId: string,
		modelFallbacks: { [key: string]: string },
	) => Promise<void>;
}

export function AccountModelMappingsDialog({
	isOpen,
	account,
	onOpenChange,
	onUpdateModelMappings,
	onUpdateModelFallbacks,
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
	const [modelFallbacks, setModelFallbacks] = useState<{
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
		if (account?.modelFallbacks) {
			setModelFallbacks({
				opus: account.modelFallbacks.opus || "",
				sonnet: account.modelFallbacks.sonnet || "",
				haiku: account.modelFallbacks.haiku || "",
			});
		} else {
			setModelFallbacks({
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

			// Save model fallbacks if handler provided
			if (onUpdateModelFallbacks) {
				const fallbacksToSend: { [key: string]: string } = {};
				if (modelFallbacks.opus.trim()) {
					fallbacksToSend.opus = modelFallbacks.opus.trim();
				}
				if (modelFallbacks.sonnet.trim()) {
					fallbacksToSend.sonnet = modelFallbacks.sonnet.trim();
				}
				if (modelFallbacks.haiku.trim()) {
					fallbacksToSend.haiku = modelFallbacks.haiku.trim();
				}

				await onUpdateModelFallbacks(account.id, fallbacksToSend);
			}

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

	const handleFallbackInputChange = (
		modelType: "opus" | "sonnet" | "haiku",
		value: string,
	) => {
		setModelFallbacks((prev) => ({
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
						Configure model mappings and fallbacks for {account.name}.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4 py-2 overflow-y-auto flex-1">
					{/* Model Mappings Section */}
					<div>
						<h4 className="text-sm font-medium mb-2">Model Mappings</h4>
						<p className="text-xs text-muted-foreground mb-3">
							Map Anthropic model names to provider-specific models (optional,
							leave empty to use defaults).
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

					{/* Model Fallbacks Section */}
					<div className="border-t pt-4">
						<h4 className="text-sm font-medium mb-2">Model Fallbacks</h4>
						<p className="text-xs text-muted-foreground mb-3">
							When a model is unavailable, retry with these fallbacks.
						</p>
						<div className="grid grid-cols-3 gap-3">
							<div className="space-y-1">
								<Label htmlFor="fallback-opus" className="text-xs">
									Opus →
								</Label>
								<Input
									id="fallback-opus"
									value={modelFallbacks.opus}
									onChange={(e) =>
										handleFallbackInputChange("opus", e.target.value)
									}
									placeholder={`e.g., ${LATEST_SONNET_MODEL}`}
									className="h-8"
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="fallback-sonnet" className="text-xs">
									Sonnet →
								</Label>
								<Input
									id="fallback-sonnet"
									value={modelFallbacks.sonnet}
									onChange={(e) =>
										handleFallbackInputChange("sonnet", e.target.value)
									}
									placeholder={`e.g., ${LATEST_HAIKU_MODEL}`}
									className="h-8"
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="fallback-haiku" className="text-xs">
									Haiku →
								</Label>
								<Input
									id="fallback-haiku"
									value={modelFallbacks.haiku}
									onChange={(e) =>
										handleFallbackInputChange("haiku", e.target.value)
									}
									placeholder={`e.g., ${LATEST_SONNET_MODEL}`}
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
