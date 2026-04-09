import { Plus } from "lucide-react";
import { useState } from "react";
import { useCombos, useDeleteCombo, useFamilies, useUpdateCombo } from "../../hooks/queries";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { ComboCard } from "./ComboCard";
import { ComboDialog } from "./ComboDialog";
import { FamilyActivationSection } from "./FamilyActivationSection";

export function CombosTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [editDialogComboId, setEditDialogComboId] = useState<string | null>(null);
	const combosQuery = useCombos();
	const familiesQuery = useFamilies();
	const deleteCombo = useDeleteCombo();
	const updateCombo = useUpdateCombo();
	const combos = combosQuery.data?.combos ?? [];
	const families = familiesQuery.data?.families ?? [];

	const getAssignedFamily = (comboId: string) => {
		const assignment = families.find((f) => f.combo_id === comboId);
		if (!assignment) return null;
		return assignment.family.charAt(0).toUpperCase() + assignment.family.slice(1);
	};

	return (
		<div className="space-y-6">
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
						<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-8 text-center">
							<p className="text-sm text-muted-foreground">
								No combos yet. Create your first combo to define a fallback
								chain.
							</p>
							<Button onClick={() => setIsCreateDialogOpen(true)}>
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
								onDelete={() => deleteCombo.mutate(combo.id)}
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
		</div>
	);
}
