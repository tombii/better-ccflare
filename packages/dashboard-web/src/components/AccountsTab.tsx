import {
	AlertCircle,
	CheckCircle,
	Pause,
	Play,
	Plus,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Account, api } from "../api";
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
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [authStep, setAuthStep] = useState<"form" | "code">("form");
	const [authCode, setAuthCode] = useState("");
	const [newAccount, setNewAccount] = useState({
		name: "",
		mode: "max" as "max" | "console",
		tier: 1,
	});

	const loadAccounts = useCallback(async () => {
		try {
			const data = await api.getAccounts();
			setAccounts(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load accounts");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadAccounts();
	}, [loadAccounts]);

	const handleAddAccount = async () => {
		if (!newAccount.name) {
			setError("Account name is required");
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
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to initialize account",
			);
		}
	};

	const handleCodeSubmit = async () => {
		if (!authCode) {
			setError("Authorization code is required");
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
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to complete account setup",
			);
		}
	};

	const handleRemoveAccount = async (name: string) => {
		if (!confirm(`Are you sure you want to remove account "${name}"?`)) return;

		try {
			await api.removeAccount(name);
			await loadAccounts();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to remove account");
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
			setError(
				err instanceof Error ? err.message : "Failed to update account status",
			);
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

	return (
		<div className="space-y-4">
			{error && (
				<Card className="border-destructive">
					<CardContent className="pt-6">
						<div className="flex items-center gap-2">
							<AlertCircle className="h-4 w-4 text-destructive" />
							<p className="text-destructive">{error}</p>
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
											setError(null);
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
												setError(null);
											}}
										>
											Cancel
										</Button>
									</div>
								</>
							)}
						</div>
					)}

					{accounts.length === 0 ? (
						<p className="text-muted-foreground">No accounts configured</p>
					) : (
						<div className="space-y-2">
							{accounts.map((account) => (
								<div
									key={account.name}
									className="flex items-center justify-between p-4 border rounded-lg"
								>
									<div className="flex items-center gap-4">
										<div>
											<p className="font-medium">{account.name}</p>
											<p className="text-sm text-muted-foreground">
												{account.provider} • Tier {account.tier}
											</p>
										</div>
										<div className="flex items-center gap-2">
											{account.tokenStatus === "valid" ? (
												<CheckCircle className="h-4 w-4 text-green-600" />
											) : (
												<AlertCircle className="h-4 w-4 text-yellow-600" />
											)}
											<span className="text-sm">
												{account.requestCount} requests
											</span>
											{account.paused && (
												<span className="text-sm text-muted-foreground">
													Paused
												</span>
											)}
											{!account.paused && account.rateLimitStatus !== "OK" && (
												<span className="text-sm text-destructive">
													{account.rateLimitStatus}
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
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
