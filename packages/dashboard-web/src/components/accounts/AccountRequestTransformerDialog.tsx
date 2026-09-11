import { useEffect, useState } from "react";
import type { Account, RequestTransformer } from "../../api";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

export const REQUEST_TRANSFORMER_NONE_VALUE = "none" as const;

type RequestTransformerSelection =
	| RequestTransformer
	| typeof REQUEST_TRANSFORMER_NONE_VALUE;

const MAX_TOKENS_TRANSFORMER =
	"max-tokens-to-max-completion-tokens" as const satisfies RequestTransformer;

function getSelectionLabel(value: RequestTransformerSelection): string {
	return value === REQUEST_TRANSFORMER_NONE_VALUE
		? "None"
		: "Max Tokens → Max Completion Tokens";
}

interface AccountRequestTransformerDialogFieldsProps {
	account: Account;
	value?: RequestTransformerSelection;
	onValueChange: (value: RequestTransformerSelection) => void;
}

export function AccountRequestTransformerDialogFields({
	account,
	value = account.requestTransformer ?? REQUEST_TRANSFORMER_NONE_VALUE,
	onValueChange,
}: AccountRequestTransformerDialogFieldsProps) {
	return (
		<div className="grid gap-2 py-4">
			<Label htmlFor="requestTransformer">Provider Transformer</Label>
			<Select
				value={value}
				onValueChange={(nextValue) =>
					onValueChange(nextValue as RequestTransformerSelection)
				}
			>
				<SelectTrigger id="requestTransformer">
					<SelectValue>{getSelectionLabel(value)}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={REQUEST_TRANSFORMER_NONE_VALUE}>None</SelectItem>
					<SelectItem value={MAX_TOKENS_TRANSFORMER}>
						Max Tokens → Max Completion Tokens
					</SelectItem>
				</SelectContent>
			</Select>
		</div>
	);
}

export async function saveAccountRequestTransformerSelection(
	accountId: string,
	value: RequestTransformerSelection,
	onUpdateRequestTransformer: (
		accountId: string,
		value: RequestTransformer | null,
	) => Promise<void>,
	onOpenChange: (open: boolean) => void,
): Promise<void> {
	await onUpdateRequestTransformer(
		accountId,
		value === REQUEST_TRANSFORMER_NONE_VALUE ? null : value,
	);
	onOpenChange(false);
}

interface AccountRequestTransformerDialogProps {
	isOpen: boolean;
	account: Account | null;
	onOpenChange: (open: boolean) => void;
	onUpdateRequestTransformer: (
		accountId: string,
		value: RequestTransformer | null,
	) => Promise<void>;
}

export function AccountRequestTransformerDialog({
	isOpen,
	account,
	onOpenChange,
	onUpdateRequestTransformer,
}: AccountRequestTransformerDialogProps) {
	const [value, setValue] = useState<RequestTransformerSelection>(
		account?.requestTransformer ?? REQUEST_TRANSFORMER_NONE_VALUE,
	);
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (isOpen && account) {
			setValue(account.requestTransformer ?? REQUEST_TRANSFORMER_NONE_VALUE);
		}
	}, [isOpen, account]);

	if (!account) return null;

	const handleSave = async () => {
		setIsSaving(true);
		try {
			await saveAccountRequestTransformerSelection(
				account.id,
				value,
				onUpdateRequestTransformer,
				onOpenChange,
			);
		} catch (error) {
			console.error("Failed to update request transformer:", error);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Provider Transformer</DialogTitle>
					<DialogDescription>
						Configure request transformation for {account.name}.
					</DialogDescription>
				</DialogHeader>
				<AccountRequestTransformerDialogFields
					account={account}
					value={value}
					onValueChange={setValue}
				/>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isSaving}
					>
						Cancel
					</Button>
					<Button type="button" onClick={handleSave} disabled={isSaving}>
						{isSaving ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
