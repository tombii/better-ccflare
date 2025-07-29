import { AccountPresenter } from "@claudeflare/ui-common";
import {
	AlertCircle,
	CheckCircle,
	Pause,
	Play,
	Plus,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { type Account, api } from "../api";
import { useAccounts } from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";

export function AccountsTab() {
	const { formatError } = useApiError();
	const {
		data: accounts,
		isLoading: loading,
		error,
		refetch: loadAccounts,
	} = useAccounts();

	const [adding, setAdding] = useState(false);
	const [authStep, setAuthStep] = useState<"form" | "code">("form");
	const [authCode, setAuthCode] = useState("");
	const [newAccount, setNewAccount] = useState({
		name: "",
		mode: "max" as "max" | "console",
		tier: 1,
	});
	const [confirmDelete, setConfirmDelete] = useState<{
		show: boolean;
		accountName: string;
		confirmInput: string;
	}>({
		show: false,
		accountName: "",
		confirmInput: "",
	});
	const [actionError, setActionError] = useState<string | null>(null);

	const handleAddAccount = async () => {
		if (!newAccount.name) {
			setActionError("Account name is required");
			return;
		}

		try {
			// Step 1: Initialize OAuth flow
			const { authUrl } = await api.initAddAccount(newAccount);

			// Open auth URL in new tab
			if (typeof window !== "undefined") {
				window.open(authUrl, "_blank");
			}

			// Move to code entry step
			setAuthStep("code");
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleCodeSubmit = async () => {
		if (!authCode) {
			setActionError("Authorization code is required");
			return;
		}

		try {
			// Step 2: Complete OAuth flow
			await api.completeAddAccount({
				name: newAccount.name,
				code: authCode,
			});

			// Success!
			await loadAccounts();
			setAdding(false);
			setAuthStep("form");
			setAuthCode("");
			setNewAccount({ name: "", mode: "max", tier: 1 });
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
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
						<div className="space-y-4 mb-6 p-4 border rounded-lg">
							<h4 className="font-medium">
								{authStep === "form"
									? "Add New Account"
									: "Enter Authorization Code"}
							</h4>
							{authStep === "form" && (
								<>
									<div className="space-y-2">
										<Label htmlFor="name">Account Name</Label>
										<Input
											id="name"
											value={newAccount.name}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													name: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="e.g., work-account"
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="mode">Mode</Label>
										<Select
											value={newAccount.mode}
											onValueChange={(value: "max" | "console") =>
												setNewAccount({ ...newAccount, mode: value })
											}
										>
											<SelectTrigger id="mode">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="max">Max (Recommended)</SelectItem>
												<SelectItem value="console">Console</SelectItem>
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-2">
										<Label htmlFor="tier">Tier</Label>
										<Select
											value={String(newAccount.tier)}
											onValueChange={(value: string) =>
												setNewAccount({ ...newAccount, tier: parseInt(value) })
											}
										>
											<SelectTrigger id="tier">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="1">Tier 1 (Default)</SelectItem>
												<SelectItem value="5">Tier 5</SelectItem>
												<SelectItem value="20">Tier 20</SelectItem>
											</SelectContent>
										</Select>
									</div>
								</>
							)}
							{authStep === "form" ? (
								<div className="flex gap-2">
									<Button onClick={handleAddAccount}>Continue</Button>
									<Button
										variant="outline"
										onClick={() => {
											setAdding(false);
											setAuthStep("form");
											setNewAccount({ name: "", mode: "max", tier: 1 });
											setActionError(null);
										}}
									>
										Cancel
									</Button>
								</div>
							) : (
								<>
									<div className="space-y-2">
										<p className="text-sm text-muted-foreground">
											A new browser tab has opened for authentication. After
											authorizing, copy the code and paste it below.
										</p>
										<Label htmlFor="code">Authorization Code</Label>
										<Input
											id="code"
											value={authCode}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setAuthCode((e.target as HTMLInputElement).value)
											}
											placeholder="Paste authorization code here"
										/>
									</div>
									<div className="flex gap-2">
										<Button onClick={handleCodeSubmit}>Complete Setup</Button>
										<Button
											variant="outline"
											onClick={() => {
												setAdding(false);
												setAuthStep("form");
												setAuthCode("");
												setNewAccount({ name: "", mode: "max", tier: 1 });
												setActionError(null);
											}}
										>
											Cancel
										</Button>
									</div>
								</>
							)}
						</div>
					)}

					{!accounts || accounts.length === 0 ? (
						<p className="text-muted-foreground">No accounts configured</p>
					) : (
						<div className="space-y-2">
							{accounts.map((account) => {
								const presenter = new AccountPresenter(account);
								return (
									<div
										key={account.name}
										className="flex items-center justify-between p-4 border rounded-lg"
									>
										<div className="flex items-center gap-4">
											<div>
												<p className="font-medium">{account.name}</p>
												<p className="text-sm text-muted-foreground">
													{account.provider} • {presenter.tierDisplay}
												</p>
											</div>
											<div className="flex items-center gap-2">
												{presenter.tokenStatus === "valid" ? (
													<CheckCircle className="h-4 w-4 text-green-600" />
												) : (
													<AlertCircle className="h-4 w-4 text-yellow-600" />
												)}
												<span className="text-sm">
													{presenter.requestCount} requests
												</span>
												{presenter.isPaused && (
													<span className="text-sm text-muted-foreground">
														Paused
													</span>
												)}
												{!presenter.isPaused &&
													presenter.rateLimitStatus !== "OK" && (
														<span className="text-sm text-destructive">
															{presenter.rateLimitStatus}
														</span>
													)}
											</div>
										</div>
										<div className="flex items-center gap-2">
											<Button
												variant="ghost"
												size="sm"
												onClick={() => handlePauseToggle(account)}
												title={
													account.paused ? "Resume account" : "Pause account"
												}
											>
												{account.paused ? (
													<Play className="h-4 w-4" />
												) : (
													<Pause className="h-4 w-4" />
												)}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => handleRemoveAccount(account.name)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</CardContent>
			</Card>

			{confirmDelete.show && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
					<Card className="w-full max-w-md">
						<CardHeader>
							<CardTitle>Confirm Account Removal</CardTitle>
							<CardDescription>This action cannot be undone.</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
								<div className="flex items-center gap-2 text-destructive">
									<AlertCircle className="h-5 w-5" />
									<p className="font-medium">Warning</p>
								</div>
								<p className="text-sm mt-2">
									You are about to permanently remove the account '
									{confirmDelete.accountName}'. This will delete all associated
									data and cannot be recovered.
								</p>
							</div>
							<div className="space-y-2">
								<Label htmlFor="confirm-input">
									Type{" "}
									<span className="font-mono font-semibold">
										{confirmDelete.accountName}
									</span>{" "}
									to confirm:
								</Label>
								<Input
									id="confirm-input"
									value={confirmDelete.confirmInput}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setConfirmDelete({
											...confirmDelete,
											confirmInput: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter account name"
									autoComplete="off"
								/>
							</div>
							<div className="flex gap-2">
								<Button
									variant="destructive"
									onClick={handleConfirmDelete}
									disabled={
										confirmDelete.confirmInput !== confirmDelete.accountName
									}
								>
									Delete Account
								</Button>
								<Button
									variant="outline"
									onClick={() => {
										setConfirmDelete({
											show: false,
											accountName: "",
											confirmInput: "",
										});
										setActionError(null);
									}}
								>
									Cancel
								</Button>
							</div>
						</CardContent>
					</Card>
				</div>
			)}
		</div>
	);
}
