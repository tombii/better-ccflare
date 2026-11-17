import { useEffect, useRef, useState } from "react";
import {
	useCreateCombo,
	useGetCombo,
	useUpdateCombo,
} from "../../hooks/queries";
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
import {
	comboFormValues,
	isComboFormDirty,
	isComboNameValid,
	shouldReseedComboForm,
} from "./combo-dialog-logic";

interface ComboDialogProps {
	isOpen: boolean;
	onClose: () => void;
	comboId?: string | null;
}

export function ComboDialog({ isOpen, onClose, comboId }: ComboDialogProps) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(true);
	// Combo id whose name/description have already been seeded into the form.
	// The dialog is remounted per open, but the combo query can refetch while
	// it is open (slot cooldowns poll), so seed only once per opened combo to
	// avoid clobbering in-progress edits.
	const seededComboIdRef = useRef<string | null>(null);
	// The combo the form was last seeded from, used to tell an external
	// change (re-seed if the form is untouched) from the user's own edits.
	const seededSnapshotRef = useRef<{
		name: string;
		description: string | null;
	} | null>(null);

	const createCombo = useCreateCombo();
	const updateCombo = useUpdateCombo();
	const comboQuery = useGetCombo(comboId ?? null);
	const combo = comboQuery.data?.combo;

	const isEditMode = !!comboId;

	useEffect(() => {
		if (!comboId || !combo) return;
		const form = { name, description };
		const isNewCombo = seededComboIdRef.current !== comboId;
		if (
			!isNewCombo &&
			!shouldReseedComboForm(form, combo, seededSnapshotRef.current)
		) {
			// Same combo, and either it has not changed or the user has unsaved
			// edits: never clobber them from a poll.
			return;
		}
		seededComboIdRef.current = comboId;
		seededSnapshotRef.current = {
			name: combo.name,
			description: combo.description,
		};
		const values = comboFormValues(combo);
		setName(values.name);
		setDescription(values.description);
	}, [comboId, combo, name, description]);

	const isNameValid = isComboNameValid(name);
	const isDirty = combo
		? isComboFormDirty({ name, description }, combo)
		: false;

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

	const handleSave = () => {
		if (!comboId || !isNameValid || !isDirty) return;

		updateCombo.mutate(
			{
				id: comboId,
				name: name.trim(),
				// Send the trimmed string even when empty: JSON.stringify drops
				// `undefined`, which the server reads as "leave unchanged", so
				// clearing a description would never persist.
				description: description.trim(),
			},
			{ onSuccess: () => handleClose() },
		);
	};

	const handleClose = () => {
		setName("");
		setDescription("");
		setEnabled(true);
		seededComboIdRef.current = null;
		seededSnapshotRef.current = null;
		onClose();
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent
				className={
					isEditMode
						? // Slot rows carry provider badge + account name + model
							// (+ routing summary): at max-w-lg the name was truncated
							// away entirely on long ids.
							"flex max-h-[90vh] w-[calc(100%-2rem)] max-w-4xl flex-col overflow-hidden"
						: "flex max-h-[90vh] max-w-lg flex-col overflow-hidden"
				}
			>
				<DialogHeader>
					<DialogTitle>
						{isEditMode ? "Edit Combo" : "Create Combo"}
					</DialogTitle>
					<DialogDescription>
						{isEditMode
							? "Rename the combo, then manage its slots. Slot changes save immediately; the name and description save with Save Changes."
							: "Define a new fallback chain for model families"}
					</DialogDescription>
				</DialogHeader>

				{isEditMode ? (
					<div className="flex min-h-0 flex-1 flex-col gap-4">
						{combo && (
							<div className="space-y-3 rounded-md border bg-muted/30 p-3">
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor="combo-edit-name">Name</Label>
										<Input
											id="combo-edit-name"
											value={name}
											onChange={(e) => setName(e.target.value)}
											placeholder="My Combo"
											maxLength={100}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="combo-edit-description">Description</Label>
										<Input
											id="combo-edit-description"
											value={description}
											onChange={(e) => setDescription(e.target.value)}
											placeholder="Optional description"
										/>
									</div>
								</div>
								{updateCombo.isError && (
									<p className="text-sm text-destructive">
										Failed to save changes. Please try again.
									</p>
								)}
							</div>
						)}
						<div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2">
							{comboQuery.isLoading && (
								<p className="text-sm text-muted-foreground">
									Loading combo...
								</p>
							)}
							{combo && <ComboSlotBuilder combo={combo} />}
						</div>
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
						disabled={createCombo.isPending || updateCombo.isPending}
					>
						Cancel
					</Button>
					{isEditMode ? (
						<Button
							onClick={handleSave}
							disabled={
								!combo || !isNameValid || !isDirty || updateCombo.isPending
							}
						>
							{updateCombo.isPending ? "Saving..." : "Save Changes"}
						</Button>
					) : (
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
