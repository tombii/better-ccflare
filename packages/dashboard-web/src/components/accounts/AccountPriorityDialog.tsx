import { useEffect, useState } from "react";
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

interface AccountPriorityDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onUpdatePriority: (accountId: string, priority: number) => Promise<void>;
}

export function AccountPriorityDialog({
	account,
	isOpen,
	onOpenChange,
	onUpdatePriority,
}: AccountPriorityDialogProps) {
	const [priority, setPriority] = useState(
		account?.priority?.toString() || "0",
	);
	const [isUpdating, setIsUpdating] = useState(false);

	// Reset priority when account changes or dialog opens
	useEffect(() => {
		if (account) {
			setPriority(account.priority?.toString() || "0");
		}
	}, [account]);

	const handleUpdate = async () => {
		if (!account) return;

		const priorityValue = parseInt(priority, 10);
		if (
			Number.isNaN(priorityValue) ||
			priorityValue < 0 ||
			priorityValue > 100
		) {
			return;
		}

		setIsUpdating(true);
		try {
			await onUpdatePriority(account.id, priorityValue);
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to update priority:", error);
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Change Account Priority</DialogTitle>
					<DialogDescription>
						Set the priority for {account?.name}. Lower priority values (0-100)
						will make this account more likely to be selected for requests.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid grid-cols-4 items-center gap-4">
						<Label htmlFor="priority" className="text-right">
							Priority
						</Label>
						<Input
							id="priority"
							type="number"
							min="0"
							max="100"
							value={priority}
							onChange={(e) => setPriority(e.target.value)}
							className="col-span-3"
						/>
					</div>
					<div className="text-sm text-muted-foreground">
						Current priority: {account?.priority || 0}
					</div>
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button type="button" onClick={handleUpdate} disabled={isUpdating}>
						{isUpdating ? "Updating..." : "Update Priority"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
