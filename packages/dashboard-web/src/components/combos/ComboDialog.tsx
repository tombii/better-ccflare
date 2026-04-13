import { useState } from "react";
import { useCreateCombo, useGetCombo } from "../../hooks/queries";
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
import { Switch } from "../ui/switch";
import { ComboSlotBuilder } from "./ComboSlotBuilder";

interface ComboDialogProps {
	isOpen: boolean;
	onClose: () => void;
	comboId?: string | null;
}

export function ComboDialog({ isOpen, onClose, comboId }: ComboDialogProps) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(true);

	const createCombo = useCreateCombo();
	const comboQuery = useGetCombo(comboId ?? null);
	const combo = comboQuery.data?.combo;

	const isEditMode = !!comboId;

	const handleCreate = () => {
		if (!name.trim()) return;

		createCombo.mutate(
			{
				name: name.trim(),
				description: description.trim() || undefined,
				enabled,
			},
			{
				onSuccess: () => {
					setName("");
					setDescription("");
					setEnabled(true);
					onClose();
				},
			},
		);
	};

	const handleClose = () => {
		setName("");
		setDescription("");
		setEnabled(true);
		onClose();
	};

	const isNameValid = name.trim().length > 0 && name.trim().length <= 100;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent className="flex max-h-[90vh] max-w-lg flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>
						{isEditMode ? "Edit Combo" : "Create Combo"}
					</DialogTitle>
					<DialogDescription>
						{isEditMode
							? "Manage slots and settings for this combo"
							: "Define a new fallback chain for model families"}
					</DialogDescription>
				</DialogHeader>

				{isEditMode ? (
					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2">
						{comboQuery.isLoading && (
							<p className="text-sm text-muted-foreground">Loading combo...</p>
						)}
						{combo && <ComboSlotBuilder combo={combo} />}
					</div>
				) : (
					<div className="space-y-4 py-2">
						<div className="space-y-2">
							<Label htmlFor="combo-name">Name</Label>
							<Input
								id="combo-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Combo"
								maxLength={100}
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="combo-description">Description</Label>
							<Input
								id="combo-description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Optional description"
							/>
						</div>

						<div className="flex items-center justify-between rounded-md border px-3 py-2">
							<Label htmlFor="combo-enabled" className="cursor-pointer">
								Enabled
							</Label>
							<Switch
								id="combo-enabled"
								checked={enabled}
								onCheckedChange={setEnabled}
							/>
						</div>

						<p className="text-xs text-muted-foreground">
							Slots can be configured after creation.
						</p>
					</div>
				)}

				{createCombo.isError && (
					<p className="text-sm text-destructive">
						Failed to create combo. Please try again.
					</p>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={handleClose}
						disabled={createCombo.isPending}
					>
						{isEditMode ? "Close" : "Cancel"}
					</Button>
					{!isEditMode && (
						<Button
							onClick={handleCreate}
							disabled={!isNameValid || createCombo.isPending}
						>
							{createCombo.isPending ? "Creating..." : "Create"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
