import { useState, useEffect } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { api, type Account } from "../api";
import { Plus, Trash2, AlertCircle, CheckCircle } from "lucide-react";

export function AccountsTab() {
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [newAccount, setNewAccount] = useState({
		name: "",
		mode: "max" as "max" | "console",
		tier: 1,
	});

	useEffect(() => {
		loadAccounts();
	}, [loadAccounts]);

	const loadAccounts = async () => {
		try {
			const data = await api.getAccounts();
			setAccounts(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load accounts");
		} finally {
			setLoading(false);
		}
	};

	const handleAddAccount = async () => {
		if (!newAccount.name) {
			setError("Account name is required");
			return;
		}

		try {
			await api.addAccount(newAccount);
			await loadAccounts();
			setAdding(false);
			setNewAccount({ name: "", mode: "max", tier: 1 });
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to add account");
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
							<h4 className="font-medium">Add New Account</h4>
							<div className="space-y-2">
								<Label htmlFor="name">Account Name</Label>
								<Input
									id="name"
									value={newAccount.name}
									onChange={(e: any) =>
										setNewAccount({
											...newAccount,
											name: e.currentTarget.value,
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
							<div className="flex gap-2">
								<Button onClick={handleAddAccount}>Add Account</Button>
								<Button
									variant="outline"
									onClick={() => {
										setAdding(false);
										setNewAccount({ name: "", mode: "max", tier: 1 });
									}}
								>
									Cancel
								</Button>
							</div>
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
											{account.rateLimitStatus !== "OK" && (
												<span className="text-sm text-destructive">
													{account.rateLimitStatus}
												</span>
											)}
										</div>
									</div>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => handleRemoveAccount(account.name)}
									>
										<Trash2 className="h-4 w-4" />
									</Button>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
