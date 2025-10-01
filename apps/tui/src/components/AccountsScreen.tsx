import * as tuiCore from "@better-ccflare/tui-core";
import type { AccountDisplay } from "@better-ccflare/types";
import { AccountPresenter } from "@better-ccflare/ui-common";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useState } from "react";

interface AccountsScreenProps {
	onBack: () => void;
}

type Mode =
	| "list"
	| "add"
	| "remove"
	| "confirmRemove"
	| "waitingForCode"
	| "setPriority";

export function AccountsScreen({ onBack }: AccountsScreenProps) {
	const [mode, setMode] = useState<Mode>("list");
	const [accounts, setAccounts] = useState<AccountDisplay[]>([]);
	const [newAccountName, setNewAccountName] = useState("");
	const [selectedMode, setSelectedMode] = useState<"max" | "console">("max");
	const [selectedTier, setSelectedTier] = useState<1 | 5 | 20>(1);
	const [step, setStep] = useState<"name" | "mode" | "tier" | "confirm">(
		"name",
	);
	const [authCode, setAuthCode] = useState("");
	const [oauthFlowData, setOauthFlowData] =
		useState<tuiCore.OAuthFlowResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [accountToRemove, setAccountToRemove] = useState("");
	const [confirmInput, setConfirmInput] = useState("");
	const [accountForPriority, setAccountForPriority] =
		useState<AccountDisplay | null>(null);
	const [priorityInput, setPriorityInput] = useState("");

	useInput((input, key) => {
		if (key.escape) {
			if (mode === "confirmRemove") {
				setMode("list");
				setAccountToRemove("");
				setConfirmInput("");
			} else if (mode === "setPriority") {
				setMode("list");
				setAccountForPriority(null);
				setPriorityInput("");
			} else if (mode === "add" || mode === "waitingForCode") {
				setMode("list");
				setNewAccountName("");
				setStep("name");
				setAuthCode("");
				setOauthFlowData(null);
				setError(null);
			} else {
				onBack();
			}
		} else if (input === "q" && mode === "list") {
			onBack();
		}
	});

	const loadAccounts = useCallback(async () => {
		const data = await tuiCore.getAccounts();
		setAccounts(data);
	}, []);

	useEffect(() => {
		loadAccounts();
	}, [loadAccounts]);

	const handleBeginAddAccount = async () => {
		try {
			const flowData = await tuiCore.beginAddAccount({
				name: newAccountName,
				mode: selectedMode,
				tier: selectedTier,
				priority: 0, // Default priority
			});
			setOauthFlowData(flowData);
			setMode("waitingForCode");
			setError(null);
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Failed to begin OAuth flow",
			);
		}
	};

	const handleCompleteAddAccount = async () => {
		if (!oauthFlowData || !authCode) return;

		try {
			await tuiCore.completeAddAccount({
				name: newAccountName,
				mode: selectedMode,
				tier: selectedTier,
				priority: 0, // Default priority
				code: authCode,
				flowData: oauthFlowData,
			});
			await loadAccounts();
			setMode("list");
			setNewAccountName("");
			setStep("name");
			setAuthCode("");
			setOauthFlowData(null);
			setError(null);
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Failed to add account",
			);
		}
	};

	const _handleRemoveAccount = (name: string) => {
		setAccountToRemove(name);
		setConfirmInput("");
		setMode("confirmRemove");
	};

	const handleSetPriority = (account: AccountDisplay) => {
		setAccountForPriority(account);
		setPriorityInput(account.priority.toString());
		setMode("setPriority");
	};

	const handleUpdatePriority = async () => {
		if (!accountForPriority || !priorityInput) return;

		const priority = parseInt(priorityInput, 10);
		if (Number.isNaN(priority) || priority < 0 || priority > 100) {
			setError("Priority must be a number between 0 and 100");
			return;
		}

		try {
			// Using tuiCore for priority update
			await tuiCore.updateAccountPriority(accountForPriority.name, priority);
			await loadAccounts();
			setMode("list");
			setAccountForPriority(null);
			setPriorityInput("");
			setError(null);
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Failed to update priority",
			);
		}
	};

	const handleConfirmRemove = async () => {
		if (confirmInput !== accountToRemove) {
			return;
		}

		try {
			await tuiCore.removeAccount(accountToRemove);
			await loadAccounts();
			setMode("list");
			setAccountToRemove("");
			setConfirmInput("");
		} catch (_error) {
			// Handle error
		}
	};

	if (mode === "add") {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="cyan" bold>
					Add Account
				</Text>

				{step === "name" && (
					<Box flexDirection="column" marginTop={1}>
						<Text>Account name:</Text>
						<TextInput
							value={newAccountName}
							onChange={setNewAccountName}
							onSubmit={() => {
								if (newAccountName) setStep("mode");
							}}
						/>
					</Box>
				)}

				{step === "mode" && (
					<Box flexDirection="column" marginTop={1}>
						<Text>Select mode:</Text>
						<SelectInput
							items={[
								{ label: "Max (recommended)", value: "max" },
								{ label: "Console", value: "console" },
							]}
							onSelect={(item) => {
								setSelectedMode(item.value as "max" | "console");
								setStep("tier");
							}}
						/>
					</Box>
				)}

				{step === "tier" && (
					<Box flexDirection="column" marginTop={1}>
						<Text>Select tier:</Text>
						<SelectInput
							items={[
								{ label: "Tier 1 (default)", value: 1 },
								{ label: "Tier 5", value: 5 },
								{ label: "Tier 20", value: 20 },
							]}
							onSelect={(item) => {
								setSelectedTier(item.value as 1 | 5 | 20);
								handleBeginAddAccount();
							}}
						/>
					</Box>
				)}

				{error && (
					<Box marginTop={1}>
						<Text color="red">{error}</Text>
					</Box>
				)}

				<Box marginTop={2}>
					<Text dimColor>Press ESC to cancel</Text>
				</Box>
			</Box>
		);
	}

	if (mode === "waitingForCode") {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="cyan" bold>
					Complete Authentication
				</Text>

				<Box flexDirection="column" marginTop={1}>
					<Text>A browser window should have opened for authentication.</Text>
					<Text>After authorizing, enter the code below:</Text>

					<Box marginTop={1}>
						<Text>Authorization code:</Text>
						<TextInput
							value={authCode}
							onChange={setAuthCode}
							onSubmit={() => {
								if (authCode) handleCompleteAddAccount();
							}}
						/>
					</Box>
				</Box>

				{error && (
					<Box marginTop={1}>
						<Text color="red">{error}</Text>
					</Box>
				)}

				<Box marginTop={2}>
					<Text dimColor>Press ESC to cancel</Text>
				</Box>
			</Box>
		);
	}

	if (mode === "confirmRemove") {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="red" bold>
					⚠️ Confirm Account Removal
				</Text>

				<Box marginTop={1} marginBottom={1}>
					<Text>You are about to remove account '{accountToRemove}'.</Text>
					<Text>This action cannot be undone.</Text>
				</Box>

				<Box flexDirection="column">
					<Text>
						Type <Text bold>{accountToRemove}</Text> to confirm:
					</Text>
					<TextInput
						value={confirmInput}
						onChange={setConfirmInput}
						onSubmit={() => {
							handleConfirmRemove();
						}}
					/>
				</Box>

				{confirmInput && confirmInput !== accountToRemove && (
					<Box marginTop={1}>
						<Text color="red">Account name does not match</Text>
					</Box>
				)}

				<Box marginTop={2}>
					<Text dimColor>Press ENTER to confirm, ESC to cancel</Text>
				</Box>
			</Box>
		);
	}

	if (mode === "setPriority") {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="cyan" bold>
					🔢 Set Account Priority
				</Text>

				<Box marginTop={1} marginBottom={1}>
					<Text>
						Setting priority for account:{" "}
						<Text bold>{accountForPriority?.name}</Text>
					</Text>
					<Text>
						Current priority: <Text bold>{accountForPriority?.priority}</Text>
					</Text>
					<Text dimColor>
						Priority values range from 0 (lowest) to 100 (highest)
					</Text>
				</Box>

				<Box flexDirection="column">
					<Text>New priority (0-100):</Text>
					<TextInput
						value={priorityInput}
						onChange={setPriorityInput}
						onSubmit={() => {
							if (priorityInput) handleUpdatePriority();
						}}
					/>
				</Box>

				{error && (
					<Box marginTop={1}>
						<Text color="red">{error}</Text>
					</Box>
				)}

				<Box marginTop={2}>
					<Text dimColor>Press ENTER to confirm, ESC to cancel</Text>
				</Box>
			</Box>
		);
	}

	const menuItems = [
		...accounts.map((acc) => {
			const presenter = new AccountPresenter(acc);
			return {
				label: `${acc.name} (${presenter.tierDisplay}) - Priority: ${acc.priority}`,
				value: `account:${acc.name}`,
			};
		}),
		{ label: "➕ Add Account", value: "add" },
		{ label: "← Back", value: "back" },
	];

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text color="cyan" bold>
					👥 Manage Accounts
				</Text>
			</Box>

			{accounts.length === 0 ? (
				<Text dimColor>No accounts configured</Text>
			) : (
				<Text dimColor>{accounts.length} account(s) configured</Text>
			)}

			<Box marginTop={1}>
				<SelectInput
					items={menuItems}
					onSelect={(item) => {
						if (item.value === "back") {
							onBack();
						} else if (item.value === "add") {
							setMode("add");
						} else if (item.value.startsWith("account:")) {
							const accountName = item.value.replace("account:", "");
							const account = accounts.find((acc) => acc.name === accountName);
							if (account) {
								handleSetPriority(account);
							}
						}
					}}
				/>
			</Box>
		</Box>
	);
}
