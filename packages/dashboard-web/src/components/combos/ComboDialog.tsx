import { useState } from "react";
import { useCreateCombo } from "../../hooks/queries";
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

interface ComboDialogProps {
	isOpen: boolean;
	onClose: () => void;
}

export function ComboDialog({ isOpen, onClose }: ComboDialogProps) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(true);

	const createCombo = useCreateCombo();

	const handleCreate = () => {
		if (!name.trim()) return;

		createCombo.mutate(
			{ name: name.trim(), description: description.trim() || undefined, enabled },
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
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Create Combo</DialogTitle>
					<DialogDescription>
						Define a new fallback chain for model families
					</DialogDescription>
				</DialogHeader>

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

					<div className="flex items-center gap-3">
						<Label htmlFor="combo-enabled">Enabled</Label>
						<Switch
							id="combo-enabled"
							checked={enabled}
							onCheckedChange={setEnabled}
						/>
					</div>

					<div className="rounded-md border border-dashed p-3">
						<p className="text-sm text-muted-foreground">
							Slots will be added after combo creation
						</p>
					</div>
				</div>

				{createCombo.isError && (
					<p className="text-sm text-destructive">
						Failed to create combo. Please try again.
					</p>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={handleClose} disabled={createCombo.isPending}>
						Cancel
					</Button>
					<Button
						onClick={handleCreate}
						disabled={!isNameValid || createCombo.isPending}
					>
						{createCombo.isPending ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
