import type { Combo } from "@better-ccflare/types";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
	useApiKeys,
	useCombos,
	useDeleteCombo,
	useFamilies,
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
import { Separator } from "../ui/separator";
import { ComboCard } from "./ComboCard";
import { ComboDialog } from "./ComboDialog";
import { CombosIntroCard } from "./CombosIntroCard";
import { countKeysOverridingCombo } from "./combo-dialog-logic";
import { FamilyActivationSection } from "./FamilyActivationSection";

export function CombosTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [editDialogComboId, setEditDialogComboId] = useState<string | null>(
		null,
	);
	// The list row carries slot_count; the bare Combo type does not.
	const [comboToDelete, setComboToDelete] = useState<
		(Combo & { slot_count: number }) | null
	>(null);
	const combosQuery = useCombos();
	const familiesQuery = useFamilies();
	const deleteCombo = useDeleteCombo();
	const updateCombo = useUpdateCombo();
	// Only needed while a delete confirmation is open, to say how many API
	// keys lose their family override. Shared cache, so this is cheap.
	const apiKeysQuery = useApiKeys({ enabled: !!comboToDelete });
	const combos = combosQuery.data?.combos ?? [];
	const families = familiesQuery.data?.families ?? [];

	const familyRoutingThrough = (comboId: string) =>
		families.find((f) => f.combo_id === comboId)?.family ?? null;

	const handleConfirmDelete = () => {
		if (!comboToDelete) return;
		deleteCombo.mutate(comboToDelete.id, {
			onSuccess: () => {
				deleteCombo.reset();
				setComboToDelete(null);
			},
		});
	};

	const handleCancelDelete = () => {
		deleteCombo.reset();
		setComboToDelete(null);
	};

	const deleteFamily = comboToDelete
		? familyRoutingThrough(comboToDelete.id)
		: null;
	const deletingKeyOverrides = comboToDelete
		? countKeysOverridingCombo(apiKeysQuery.data, comboToDelete.id)
		: 0;
	const deleteFamilyLabel = deleteFamily
		? deleteFamily.charAt(0).toUpperCase() + deleteFamily.slice(1)
		: null;

	const getAssignedFamily = (comboId: string) => {
		const assignment = families.find((f) => f.combo_id === comboId);
		if (!assignment) return null;
		return (
			assignment.family.charAt(0).toUpperCase() + assignment.family.slice(1)
		);
	};

	return (
		<div className="space-y-6">
			<CombosIntroCard />

			<FamilyActivationSection />

			<Separator />

			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-semibold">Combos</h2>
					<Button onClick={() => setIsCreateDialogOpen(true)}>
						<Plus className="mr-2 h-4 w-4" />
						Create Combo
					</Button>
				</div>

				{combosQuery.isLoading && (
					<p className="text-sm text-muted-foreground">Loading combos...</p>
				)}

				{combosQuery.isError && (
					<p className="text-sm text-destructive">Failed to load combos.</p>
				)}

				{!combosQuery.isLoading &&
					!combosQuery.isError &&
					combos.length === 0 && (
						<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-8 py-12 text-center">
							<p className="text-sm text-muted-foreground">
								No combos yet. Create one to define a fallback chain.
							</p>
							<Button size="sm" onClick={() => setIsCreateDialogOpen(true)}>
								<Plus className="mr-2 h-4 w-4" />
								Create Combo
							</Button>
						</div>
					)}

				{combos.length > 0 && (
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{combos.map((combo) => (
							<ComboCard
								key={combo.id}
								combo={combo}
								slotCount={combo.slot_count}
								assignedFamily={getAssignedFamily(combo.id)}
								onEdit={() => setEditDialogComboId(combo.id)}
								onDelete={() => setComboToDelete(combo)}
								onToggleEnabled={(enabled) =>
									updateCombo.mutate({ id: combo.id, enabled })
								}
							/>
						))}
					</div>
				)}
			</div>

			<ComboDialog
				isOpen={isCreateDialogOpen}
				onClose={() => setIsCreateDialogOpen(false)}
			/>

			<ComboDialog
				isOpen={!!editDialogComboId}
				comboId={editDialogComboId}
				onClose={() => setEditDialogComboId(null)}
			/>

			<Dialog
				open={!!comboToDelete}
				onOpenChange={(open) =>
					!open && !deleteCombo.isPending && handleCancelDelete()
				}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>Delete combo?</DialogTitle>
						<DialogDescription>
							{comboToDelete
								? `"${comboToDelete.name}" and its ${comboToDelete.slot_count} ${
										comboToDelete.slot_count === 1 ? "slot" : "slots"
									} will be removed permanently. This cannot be undone.`
								: null}
						</DialogDescription>
					</DialogHeader>

					{(deleteFamily || deletingKeyOverrides > 0) && (
						<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
							{deleteFamily && (
								<li>
									The{" "}
									<span className="font-medium text-foreground">
										{deleteFamilyLabel}
									</span>{" "}
									family currently routes through this combo. It will fall back
									to normal pool routing.
								</li>
							)}
							{deletingKeyOverrides > 0 && (
								<li>
									{deletingKeyOverrides}{" "}
									{deletingKeyOverrides === 1 ? "API key" : "API keys"} override
									a family to this combo.{" "}
									{deletingKeyOverrides === 1
										? "That override"
										: "Those overrides"}{" "}
									will be removed.
								</li>
							)}
						</ul>
					)}

					{deleteCombo.isError && (
						<p className="text-sm text-destructive">
							Failed to delete combo. Please try again.
						</p>
					)}

					<DialogFooter>
						<Button
							variant="outline"
							onClick={handleCancelDelete}
							disabled={deleteCombo.isPending}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={handleConfirmDelete}
							disabled={deleteCombo.isPending}
						>
							{deleteCombo.isPending ? "Deleting..." : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
