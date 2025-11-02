import { AlertCircle, Plus } from "lucide-react";
import { useState } from "react";
import { type Account, api } from "../api";
import { useAccounts, useRenameAccount } from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import {
	AccountAddForm,
	AccountCustomEndpointDialog,
	AccountList,
	AccountModelMappingsDialog,
	AccountPriorityDialog,
	DeleteConfirmationDialog,
	RenameAccountDialog,
} from "./accounts";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

export function AccountsTab() {
	const { formatError } = useApiError();
	const {
		data: accounts,
		isLoading: loading,
		error,
		refetch: loadAccounts,
	} = useAccounts();
	const renameAccount = useRenameAccount();

	const [adding, setAdding] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<{
		show: boolean;
		accountName: string;
		confirmInput: string;
	}>({
		show: false,
		accountName: "",
		confirmInput: "",
	});
	const [renameDialog, setRenameDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [priorityDialog, setPriorityDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [customEndpointDialog, setCustomEndpointDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [modelMappingsDialog, setModelMappingsDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [actionError, setActionError] = useState<string | null>(null);

	const handleAddAccount = async (params: {
		name: string;
		mode:
			| "claude-oauth"
			| "console"
			| "zai"
			| "minimax"
			| "nanogpt"
			| "anthropic-compatible"
			| "openai-compatible";
		priority: number;
		customEndpoint?: string;
	}) => {
		try {
			const result = await api.initAddAccount(params);
			setActionError(null);
			return result;
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleCompleteAccount = async (params: {
		sessionId: string;
		code: string;
	}) => {
		try {
			await api.completeAddAccount(params);
			await loadAccounts();
			setAdding(false);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAddZaiAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
	}) => {
		try {
			await api.addZaiAccount(params);
			await loadAccounts();
			setAdding(false);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAddOpenAIAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint: string;
		modelMappings?: { [key: string]: string };
	}) => {
		try {
			await api.addOpenAIAccount(params);
			await loadAccounts();
			setAdding(false);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAddMinimaxAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
	}) => {
		try {
			await api.addMinimaxAccount(params);
			await loadAccounts();
			setAdding(false);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAddAnthropicCompatibleAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		try {
			await api.addAnthropicCompatibleAccount(params);
			await loadAccounts();
			setAdding(false);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAddNanoGPTAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		try {
			await api.addNanoGPTAccount(params);
			await loadAccounts();
			setAdding(false);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleRemoveAccount = (name: string) => {
		setConfirmDelete({ show: true, accountName: name, confirmInput: "" });
	};

	const handleConfirmDelete = async () => {
		if (confirmDelete.confirmInput !== confirmDelete.accountName) {
			setActionError(
				"Account name does not match. Please type the exact account name.",
			);
			return;
		}

		try {
			await api.removeAccount(
				confirmDelete.accountName,
				confirmDelete.confirmInput,
			);
			await loadAccounts();
			setConfirmDelete({ show: false, accountName: "", confirmInput: "" });
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleRename = (account: Account) => {
		setRenameDialog({ isOpen: true, account });
	};

	const handleConfirmRename = async (newName: string) => {
		if (!renameDialog.account) return;

		try {
			await renameAccount.mutateAsync({
				accountId: renameDialog.account.id,
				newName,
			});
			setRenameDialog({ isOpen: false, account: null });
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handlePauseToggle = async (account: Account) => {
		try {
			if (account.paused) {
				await api.resumeAccount(account.id);
			} else {
				await api.pauseAccount(account.id);
			}
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handlePriorityChange = (account: Account) => {
		setPriorityDialog({ isOpen: true, account });
	};

	const handleUpdatePriority = async (accountId: string, priority: number) => {
		try {
			await api.updateAccountPriority(accountId, priority);
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAutoFallbackToggle = async (account: Account) => {
		try {
			await api.updateAccountAutoFallback(
				account.id,
				!account.autoFallbackEnabled,
			);
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleAutoRefreshToggle = async (account: Account) => {
		try {
			await api.updateAccountAutoRefresh(
				account.id,
				!account.autoRefreshEnabled,
			);
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleCustomEndpointChange = (account: Account) => {
		setCustomEndpointDialog({ isOpen: true, account });
	};

	const handleModelMappingsChange = (account: Account) => {
		setModelMappingsDialog({ isOpen: true, account });
	};

	const handleUpdateCustomEndpoint = async (
		accountId: string,
		customEndpoint: string | null,
	) => {
		try {
			await api.updateAccountCustomEndpoint(accountId, customEndpoint);
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleUpdateModelMappings = async (
		accountId: string,
		modelMappings: { [key: string]: string },
	) => {
		try {
			await api.updateAccountModelMappings(accountId, modelMappings);
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	if (loading) {
		return (
			<Card>
				<CardContent className="pt-6">
					<p className="text-muted-foreground">Loading accounts...</p>
				</CardContent>
			</Card>
		);
	}

	const displayError = error ? formatError(error) : actionError;

	return (
		<div className="space-y-4">
			{displayError && (
				<Card className="border-destructive">
					<CardContent className="pt-6">
						<div className="flex items-center gap-2">
							<AlertCircle className="h-4 w-4 text-destructive" />
							<p className="text-destructive">{displayError}</p>
						</div>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle>Accounts</CardTitle>
							<CardDescription>Manage your Claude accounts</CardDescription>
						</div>
						{!adding && (
							<Button onClick={() => setAdding(true)} size="sm">
								<Plus className="mr-2 h-4 w-4" />
								Add Account
							</Button>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{adding && (
						<AccountAddForm
							onAddAccount={handleAddAccount}
							onCompleteAccount={handleCompleteAccount}
							onAddZaiAccount={handleAddZaiAccount}
							onAddMinimaxAccount={handleAddMinimaxAccount}
							onAddAnthropicCompatibleAccount={
								handleAddAnthropicCompatibleAccount
							}
							onAddOpenAIAccount={handleAddOpenAIAccount}
							onAddNanoGPTAccount={handleAddNanoGPTAccount}
							onCancel={() => {
								setAdding(false);
								setActionError(null);
							}}
							onSuccess={() => {
								setAdding(false);
							}}
							onError={setActionError}
						/>
					)}

					<AccountList
						accounts={accounts}
						onPauseToggle={handlePauseToggle}
						onRemove={handleRemoveAccount}
						onRename={handleRename}
						onPriorityChange={handlePriorityChange}
						onAutoFallbackToggle={handleAutoFallbackToggle}
						onAutoRefreshToggle={handleAutoRefreshToggle}
						onCustomEndpointChange={handleCustomEndpointChange}
						onModelMappingsChange={handleModelMappingsChange}
					/>
				</CardContent>
			</Card>

			{confirmDelete.show && (
				<DeleteConfirmationDialog
					accountName={confirmDelete.accountName}
					confirmInput={confirmDelete.confirmInput}
					onConfirmInputChange={(value) =>
						setConfirmDelete({
							...confirmDelete,
							confirmInput: value,
						})
					}
					onConfirm={handleConfirmDelete}
					onCancel={() => {
						setConfirmDelete({
							show: false,
							accountName: "",
							confirmInput: "",
						});
						setActionError(null);
					}}
				/>
			)}

			{renameDialog.isOpen && renameDialog.account && (
				<RenameAccountDialog
					isOpen={renameDialog.isOpen}
					currentName={renameDialog.account.name}
					onClose={() => setRenameDialog({ isOpen: false, account: null })}
					onRename={handleConfirmRename}
					isLoading={renameAccount.isPending}
				/>
			)}

			{priorityDialog.isOpen && priorityDialog.account && (
				<AccountPriorityDialog
					account={priorityDialog.account}
					isOpen={priorityDialog.isOpen}
					onOpenChange={(open) =>
						setPriorityDialog({
							isOpen: open,
							account: open ? priorityDialog.account : null,
						})
					}
					onUpdatePriority={handleUpdatePriority}
				/>
			)}

			{customEndpointDialog.isOpen && customEndpointDialog.account && (
				<AccountCustomEndpointDialog
					isOpen={customEndpointDialog.isOpen}
					account={customEndpointDialog.account}
					onOpenChange={(open) =>
						setCustomEndpointDialog({
							isOpen: open,
							account: open ? customEndpointDialog.account : null,
						})
					}
					onUpdateEndpoint={handleUpdateCustomEndpoint}
				/>
			)}
			{modelMappingsDialog.isOpen && modelMappingsDialog.account && (
				<AccountModelMappingsDialog
					isOpen={modelMappingsDialog.isOpen}
					account={modelMappingsDialog.account}
					onOpenChange={(open) =>
						setModelMappingsDialog({
							isOpen: open,
							account: open ? modelMappingsDialog.account : null,
						})
					}
					onUpdateModelMappings={handleUpdateModelMappings}
				/>
			)}
		</div>
	);
}
