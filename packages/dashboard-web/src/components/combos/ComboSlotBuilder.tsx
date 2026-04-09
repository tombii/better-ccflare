import {
	DndContext,
	type DragEndEvent,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ComboSlot, ComboWithSlots } from "@better-ccflare/types";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
	useAccounts,
	useAddComboSlot,
	useRemoveComboSlot,
	useReorderComboSlots,
} from "../../hooks/queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface SortableSlotRowProps {
	slot: ComboSlot;
	comboId: string;
	index: number;
	accountName: string;
	provider: string;
	onRemove: () => void;
	isRemoving: boolean;
}

function SortableSlotRow({
	slot,
	index,
	accountName,
	provider,
	onRemove,
	isRemoving,
}: SortableSlotRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
		useSortable({ id: slot.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className="flex items-center gap-2 rounded-md border p-2"
		>
			<span className="w-5 shrink-0 text-center text-xs font-medium text-muted-foreground">
				{index}
			</span>
			<button
				type="button"
				className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
				{...attributes}
				{...listeners}
			>
				<GripVertical className="h-4 w-4" />
			</button>

			<div className="flex min-w-0 flex-1 items-center gap-2">
				<Badge variant="secondary" className="shrink-0 text-xs">
					{provider}
				</Badge>
				<span className="truncate text-sm">{accountName}</span>
			</div>

			<span className="shrink-0 text-sm text-muted-foreground">{slot.model}</span>

			<Badge variant="outline" className="shrink-0 text-xs text-muted-foreground">
				In Use
			</Badge>

			<Button
				variant="ghost"
				size="sm"
				onClick={onRemove}
				disabled={isRemoving}
				className="shrink-0 text-destructive hover:text-destructive"
			>
				<Trash2 className="h-4 w-4" />
			</Button>
		</div>
	);
}

interface ComboSlotBuilderProps {
	combo: ComboWithSlots;
}

export function ComboSlotBuilder({ combo }: ComboSlotBuilderProps) {
	const [showAddForm, setShowAddForm] = useState(false);
	const [newAccountId, setNewAccountId] = useState("");
	const [newModel, setNewModel] = useState("");

	const accountsQuery = useAccounts();
	const addSlot = useAddComboSlot();
	const removeSlot = useRemoveComboSlot();
	const reorderSlots = useReorderComboSlots();

	const accounts = accountsQuery.data ?? [];

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
	);

	const getAccountInfo = (accountId: string) => {
		const account = accounts.find((a) => a.id === accountId);
		return {
			name: account?.name ?? accountId,
			provider: account?.provider ?? "unknown",
		};
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;

		const oldIndex = combo.slots.findIndex((s) => s.id === active.id);
		const newIndex = combo.slots.findIndex((s) => s.id === over.id);
		if (oldIndex === -1 || newIndex === -1) return;

		const reordered = [...combo.slots];
		const [moved] = reordered.splice(oldIndex, 1);
		reordered.splice(newIndex, 0, moved);

		reorderSlots.mutate({
			comboId: combo.id,
			slotIds: reordered.map((s) => s.id),
		});
	};

	const handleAddSlot = () => {
		if (!newAccountId || !newModel.trim()) return;
		addSlot.mutate(
			{ comboId: combo.id, params: { account_id: newAccountId, model: newModel.trim() } },
			{
				onSuccess: () => {
					setNewAccountId("");
					setNewModel("");
					setShowAddForm(false);
				},
			},
		);
	};

	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<CardTitle className="text-sm">Slots</CardTitle>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowAddForm((v) => !v)}
					>
						<Plus className="mr-1 h-3 w-3" />
						Add Slot
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-2">
				{showAddForm && (
					<div className="flex items-end gap-2 rounded-md border border-dashed p-2">
						<div className="flex-1 space-y-1">
							<Label className="text-xs">Account</Label>
							<Select value={newAccountId} onValueChange={setNewAccountId}>
								<SelectTrigger className="h-8 text-xs">
									<SelectValue placeholder="Select account..." />
								</SelectTrigger>
								<SelectContent>
									{accounts.map((account) => (
										<SelectItem key={account.id} value={account.id}>
											<span className="flex items-center gap-2">
												<Badge variant="secondary" className="text-xs">
													{account.provider}
												</Badge>
												{account.name}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex-1 space-y-1">
							<Label className="text-xs">Model</Label>
							<Input
								className="h-8 text-xs"
								value={newModel}
								onChange={(e) => setNewModel(e.target.value)}
								placeholder="claude-3-opus"
							/>
						</div>
						<Button
							size="sm"
							className="h-8"
							onClick={handleAddSlot}
							disabled={!newAccountId || !newModel.trim() || addSlot.isPending}
						>
							{addSlot.isPending ? "Adding..." : "Add"}
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="h-8"
							onClick={() => {
								setShowAddForm(false);
								setNewAccountId("");
								setNewModel("");
							}}
						>
							Cancel
						</Button>
					</div>
				)}

				{combo.slots.length === 0 && !showAddForm && (
					<p className="py-2 text-center text-sm text-muted-foreground">
						No slots yet. Add a slot to define the fallback chain.
					</p>
				)}

				{combo.slots.length > 0 && (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={combo.slots.map((s) => s.id)}
							strategy={verticalListSortingStrategy}
						>
							<div className="space-y-1">
								{combo.slots.map((slot, index) => {
									const { name, provider } = getAccountInfo(slot.account_id);
									return (
										<SortableSlotRow
											key={slot.id}
											slot={slot}
											comboId={combo.id}
											accountName={name}
											provider={provider}
											index={index + 1}
											onRemove={() =>
												removeSlot.mutate({
													comboId: combo.id,
													slotId: slot.id,
												})
											}
											isRemoving={removeSlot.isPending}
										/>
									);
								})}
							</div>
						</SortableContext>
					</DndContext>
				)}
			</CardContent>
		</Card>
	);
}
