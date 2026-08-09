import type { ComboSlot, ComboWithSlots } from "@better-ccflare/types";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
	useAccounts,
	useAddComboSlot,
	useFamilies,
	useRemoveComboSlot,
	useReorderComboSlots,
} from "../../hooks/queries";
import { providerAllowsClientModelPassthrough } from "../../utils/provider-utils";
import { ModelCombobox } from "../models/ModelCombobox";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
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
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: slot.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
		>
			<span className="w-4 shrink-0 text-center text-xs font-medium text-muted-foreground">
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
				<span className="truncate text-sm font-medium">{accountName}</span>
			</div>

			<span className="shrink-0 font-mono text-xs text-muted-foreground">
				{slot.model?.trim() ? (
					slot.model
				) : (
					<span className="italic">client model</span>
				)}
			</span>

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

/**
 * Help line under the model field — must state the rule that applies TO THE
 * SELECTED ACCOUNT, not a universal "Empty = passthrough" that only holds
 * on the Anthropic provider.
 */
function modelFieldHint(
	provider: string | null,
	passthroughAllowed: boolean,
): string {
	if (!provider) {
		return "Pick an account first: whether the model is required depends on the provider.";
	}
	if (passthroughAllowed) {
		return "Empty = passthrough: the model sent by the client goes upstream untouched.";
	}
	return `Required for ${provider}: this provider does not serve Claude model ids, so there is no passthrough.`;
}

interface ComboSlotBuilderProps {
	combo: ComboWithSlots;
}

export function ComboSlotBuilder({ combo }: ComboSlotBuilderProps) {
	const [showAddForm, setShowAddForm] = useState(false);
	const [newAccountId, setNewAccountId] = useState("");
	const [newModel, setNewModel] = useState("");

	const accountsQuery = useAccounts();
	const familiesQuery = useFamilies();
	const addSlot = useAddComboSlot();
	const removeSlot = useRemoveComboSlot();
	const reorderSlots = useReorderComboSlots();

	const accounts = accountsQuery.data ?? [];
	const families = familiesQuery.data?.families ?? [];
	const assignedFamily = families.find((f) => f.combo_id === combo.id);
	// The combobox needs the provider of the chosen account: without it the
	// list suggested a Claude model for an OpenAI account.
	const selectedProvider =
		accounts.find((a) => a.id === newAccountId)?.provider ?? null;
	// DERIVED on every render from (selected account + field text). None of
	// this is copied into useState or synced via useEffect — that is what
	// guarantees coherence when the user types first and switches the account
	// afterward: label, hint, and the Add button's disabled state are all
	// recomputed in the same render, so no click order lets an invalid slot through.
	const passthroughAllowed =
		providerAllowsClientModelPassthrough(selectedProvider);
	const modelRequired = Boolean(selectedProvider) && !passthroughAllowed;
	const missingRequiredModel = modelRequired && newModel.trim().length === 0;

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
		// The model is only optional on a passthrough provider (the rule lives in
		// utils/provider-utils). Outside those, an empty field means an invalid
		// slot: the button is already disabled, this guard is the seatbelt against
		// any code path that calls this anyway.
		if (!newAccountId || missingRequiredModel) return;
		addSlot.mutate(
			{
				comboId: combo.id,
				params: { account_id: newAccountId, model: newModel.trim() },
			},
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
				{assignedFamily && (
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<span>Assigned to:</span>
						<Badge variant="default" className="text-xs">
							{assignedFamily.family.charAt(0).toUpperCase() +
								assignedFamily.family.slice(1)}
						</Badge>
					</div>
				)}
				{showAddForm && (
					<div className="space-y-3 rounded-md border border-dashed p-3">
						<div className="space-y-1.5">
							<Label>Account</Label>
							<Select value={newAccountId} onValueChange={setNewAccountId}>
								<SelectTrigger>
									<SelectValue placeholder="Select account...">
										{newAccountId &&
											(() => {
												const acc = accounts.find((a) => a.id === newAccountId);
												return acc ? acc.name : newAccountId;
											})()}
									</SelectValue>
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
						<div className="space-y-1.5">
							<Label>{passthroughAllowed ? "Model (optional)" : "Model"}</Label>
							<div className="flex items-center gap-1.5">
								<ModelCombobox
									provider={selectedProvider}
									accountId={newAccountId || null}
									value={newModel}
									onChange={setNewModel}
									placeholder="Model id"
									className="flex-1"
								/>
							</div>
							<p className="text-[11px] text-muted-foreground">
								{modelFieldHint(selectedProvider, passthroughAllowed)} Test
								sends one real request to the provider and consumes quota.
							</p>
						</div>
						<div className="flex items-center justify-end gap-2">
							{missingRequiredModel && (
								<p className="mr-auto text-[11px] text-destructive">
									Pick a model: {selectedProvider} does not accept passthrough.
								</p>
							)}
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									setShowAddForm(false);
									setNewAccountId("");
									setNewModel("");
								}}
							>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={handleAddSlot}
								disabled={
									!newAccountId || missingRequiredModel || addSlot.isPending
								}
								title={
									missingRequiredModel
										? `A model is required for ${selectedProvider}: this provider does not serve Claude model ids, so there is no passthrough.`
										: undefined
								}
							>
								{addSlot.isPending ? "Adding..." : "Add"}
							</Button>
						</div>
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
