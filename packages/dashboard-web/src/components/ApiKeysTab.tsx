import type {
	ApiKeyGenerationResult,
	ApiKeyResponse,
	ApiKeyRestrictions,
} from "@better-ccflare/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangle,
	ChevronDown,
	Plus,
	Shield,
	SlidersHorizontal,
	ToggleLeft,
	ToggleRight,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAccounts, useApiKeys } from "../hooks/queries";
import { queryKeys } from "../lib/query-keys";
import { ApiKeyRestrictionsEditor } from "./api-keys/ApiKeyRestrictionsEditor";
import { ApiKeyRestrictionsSummary } from "./api-keys/ApiKeyRestrictionsSummary";
import {
	restrictionsOf,
	UNRESTRICTED_RESTRICTIONS,
} from "./api-keys/restrictions";
import { CopyButton } from "./CopyButton";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ApiKeyStatsResponse {
	success: boolean;
	data: {
		total: number;
		active: number;
		inactive: number;
	};
}

interface ApiKeyGenerationResponse {
	success: boolean;
	data: ApiKeyGenerationResult;
}

interface RestrictionsUpdateResponse {
	success: boolean;
	message: string;
}

export function ApiKeysTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [newKeyName, setNewKeyName] = useState("");
	const [selectedKey, setSelectedKey] = useState<ApiKeyResponse | null>(null);
	const [generatedKey, setGeneratedKey] = useState<string | null>(null);
	const [isAdminKey, setIsAdminKey] = useState(false);
	const [showNewKeyRestrictions, setShowNewKeyRestrictions] = useState(false);
	const [newKeyRestrictions, setNewKeyRestrictions] =
		useState<ApiKeyRestrictions>(UNRESTRICTED_RESTRICTIONS);
	// The key whose restrictions are being edited, plus the draft it is edited
	// into. Null closes the dialog.
	const [restrictionsKey, setRestrictionsKey] = useState<ApiKeyResponse | null>(
		null,
	);
	const [restrictionsDraft, setRestrictionsDraft] =
		useState<ApiKeyRestrictions>(UNRESTRICTED_RESTRICTIONS);

	const queryClient = useQueryClient();

	// Names for the account ids held in allowedAccounts. An id with no entry
	// here belongs to a deleted account and is rendered as such rather than
	// dropped.
	const { data: accounts } = useAccounts();
	const accountNames = useMemo(
		() =>
			new Map((accounts ?? []).map((account) => [account.id, account.name])),
		[accounts],
	);

	// Fetch API key statistics - only when not showing the generated key dialog
	const { data: statsResponse, error: statsError } =
		useQuery<ApiKeyStatsResponse>({
			queryKey: ["api-keys-stats"],
			queryFn: async () => {
				return api.get<ApiKeyStatsResponse>("/api/api-keys/stats");
			},
			enabled: !generatedKey, // Don't fetch while showing generated key
		});

	// Default to admin if this is the first key, otherwise api-only
	useEffect(() => {
		if (statsResponse?.data) {
			setIsAdminKey(statsResponse.data.active === 0);
		}
	}, [statsResponse]);

	// Fetch API keys - only when not showing the generated key dialog.
	// Goes through the shared hook so this tab and every other consumer read
	// and write the same cache entry (queryKeys.apiKeys()) in the same shape.
	const {
		data: apiKeysData,
		isLoading: isLoadingKeys,
		error: keysError,
	} = useApiKeys({ enabled: !generatedKey });

	// Generate API key mutation
	const generateKeyMutation = useMutation({
		mutationFn: async (params: {
			name: string;
			role: "admin" | "api-only";
			restrictions: ApiKeyRestrictions;
		}) => {
			const result = await api.post<ApiKeyGenerationResponse>("/api/api-keys", {
				name: params.name,
				role: params.role,
				...params.restrictions,
			});
			return result.data;
		},
		onSuccess: (data) => {
			setGeneratedKey(data.apiKey);
			setNewKeyName("");
			setIsAdminKey(false);
			setNewKeyRestrictions(UNRESTRICTED_RESTRICTIONS);
			setShowNewKeyRestrictions(false);
			setIsCreateDialogOpen(false);
			// Don't invalidate queries here - wait until user authenticates
			// This prevents 401 errors if the stored key is invalid
		},
		onError: (error: Error) => {
			console.error("Failed to generate API key:", error);
		},
	});

	const handleSavedKey = () => {
		// Close the dialog
		setGeneratedKey(null);
		// Trigger auth dialog so user can paste the key they just copied
		window.dispatchEvent(new CustomEvent("auth-required"));
	};

	// Toggle API key status mutation
	const toggleKeyMutation = useMutation({
		mutationFn: async ({ name, enable }: { name: string; enable: boolean }) => {
			const endpoint = enable
				? `/api/api-keys/${encodeURIComponent(name)}/enable`
				: `/api/api-keys/${encodeURIComponent(name)}/disable`;
			return api.post(endpoint);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
		onError: (error: Error) => {
			console.error("Failed to toggle API key:", error);
		},
	});

	// Delete API key mutation
	const deleteKeyMutation = useMutation({
		mutationFn: async (name: string) => {
			return api.delete(`/api/api-keys/${encodeURIComponent(name)}`);
		},
		onSuccess: () => {
			setSelectedKey(null);
			setIsDeleteDialogOpen(false);
			queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
		onError: (error: Error) => {
			console.error("Failed to delete API key:", error);
		},
	});

	// Update API key role mutation
	const updateRoleMutation = useMutation({
		mutationFn: async ({
			keyId,
			role,
		}: {
			keyId: string;
			role: "admin" | "api-only";
		}) => {
			return api.updateApiKeyRole(keyId, role);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
		onError: (error: Error) => {
			console.error("Failed to update API key role:", error);
		},
	});

	// Update per-key restrictions. All three fields are always sent: the
	// endpoint replaces the triple wholesale, so omitting one would be
	// indistinguishable from clearing it.
	const updateRestrictionsMutation = useMutation({
		mutationFn: async ({
			keyId,
			restrictions,
		}: {
			keyId: string;
			restrictions: ApiKeyRestrictions;
		}) => {
			return api.patch<RestrictionsUpdateResponse>(
				`/api/api-keys/${encodeURIComponent(keyId)}/restrictions`,
				{
					allowedAccounts: restrictions.allowedAccounts,
					allowedModels: restrictions.allowedModels,
					allowedProviders: restrictions.allowedProviders,
				},
			);
		},
		onSuccess: () => {
			setRestrictionsKey(null);
			queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
		},
		onError: (error: Error) => {
			console.error("Failed to update API key restrictions:", error);
		},
	});

	const handleGenerateKey = () => {
		if (!newKeyName.trim()) return;
		const isFirstKey = !stats || stats.active === 0;
		const role = isFirstKey || isAdminKey ? "admin" : "api-only";
		generateKeyMutation.mutate({
			name: newKeyName.trim(),
			role,
			restrictions: newKeyRestrictions,
		});
	};

	const handleEditRestrictions = (key: ApiKeyResponse) => {
		setRestrictionsDraft(restrictionsOf(key));
		setRestrictionsKey(key);
		updateRestrictionsMutation.reset();
	};

	const confirmRestrictions = () => {
		if (!restrictionsKey) return;
		updateRestrictionsMutation.mutate({
			keyId: restrictionsKey.id,
			restrictions: restrictionsDraft,
		});
	};

	const handleToggleKey = (key: ApiKeyResponse, enable: boolean) => {
		toggleKeyMutation.mutate({ name: key.name, enable });
	};

	const handleDeleteKey = (key: ApiKeyResponse) => {
		setSelectedKey(key);
		setIsDeleteDialogOpen(true);
	};

	const confirmDeleteKey = () => {
		if (selectedKey) {
			deleteKeyMutation.mutate(selectedKey.name);
		}
	};

	const handleUpdateRole = (
		key: ApiKeyResponse,
		newRole: "admin" | "api-only",
	) => {
		if (key.role === newRole) return;
		updateRoleMutation.mutate({ keyId: key.id, role: newRole });
	};

	// Determine if a key's role can be changed
	const canChangeRole = (key: ApiKeyResponse) => {
		// Cannot change the first key (oldest by creation date)
		const sortedKeys = [...apiKeys].sort(
			(a, b) =>
				new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);
		const firstKey = sortedKeys[0];
		if (firstKey && key.id === firstKey.id) {
			return false;
		}

		// Get the current authenticated key from session storage
		const currentApiKey = api.getApiKey();
		if (currentApiKey) {
			// Check if this key matches the current one by comparing the last 8 chars
			// This is a heuristic check since we don't have the full key ID on the client
			// The server will enforce the proper check
			// For now, we'll just show all keys as changeable except the first key
		}

		return true;
	};

	const stats = statsResponse?.data;
	const apiKeys = apiKeysData ?? [];

	if (keysError || statsError) {
		return (
			<Card>
				<CardContent className="p-6">
					<div className="flex items-center gap-2 text-destructive">
						<AlertTriangle className="h-5 w-5" />
						<span>Failed to load API keys. Please try again.</span>
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-6">
			{/* Statistics Cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-medium">Total Keys</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">{stats?.total || 0}</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-medium">Active Keys</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold text-green-600">
							{stats?.active || 0}
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-medium">
							Inactive Keys
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold text-muted-foreground">
							{stats?.inactive || 0}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Header with Create Button */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-xl font-semibold">API Keys</h2>
					<p className="text-muted-foreground">
						Manage API keys for authentication. When at least one key is active,
						all API requests must include a valid API key.
					</p>
				</div>
				<Dialog
					open={isCreateDialogOpen}
					onOpenChange={(open) => {
						setIsCreateDialogOpen(open);
						if (!open) generateKeyMutation.reset();
					}}
				>
					<DialogTrigger asChild>
						<Button>
							<Plus className="h-4 w-4 mr-2" />
							Generate API Key
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Generate New API Key</DialogTitle>
							<DialogDescription>
								Create a new API key for authentication. The key will be shown
								only once, so save it securely.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-4 py-4">
							<div className="space-y-2">
								<Label htmlFor="name">Key Name</Label>
								<Input
									id="name"
									placeholder="e.g., Production App, Development Key"
									value={newKeyName}
									onChange={(e) => setNewKeyName(e.target.value)}
								/>
							</div>
							{(() => {
								const isFirstKey = !stats || stats.active === 0;
								return (
									<>
										<div className="flex items-center space-x-2">
											<input
												type="checkbox"
												id="admin"
												checked={isAdminKey}
												onChange={(e) => setIsAdminKey(e.target.checked)}
												disabled={isFirstKey}
												className="h-4 w-4 rounded border-gray-300 disabled:cursor-not-allowed disabled:opacity-60"
											/>
											<Label
												htmlFor="admin"
												className={`text-sm font-normal ${isFirstKey ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
											>
												Grant admin access (dashboard management)
											</Label>
										</div>
										{isFirstKey ? (
											<div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
												<div className="flex items-center gap-2 text-yellow-800">
													<AlertTriangle className="h-4 w-4" />
													<span className="text-sm">
														First API key must be admin to prevent lockout from
														the dashboard.
													</span>
												</div>
											</div>
										) : isAdminKey ? (
											<div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
												<div className="flex items-center gap-2 text-yellow-800">
													<AlertTriangle className="h-4 w-4" />
													<span className="text-sm">
														Admin keys can manage accounts, view analytics, and
														modify settings.
													</span>
												</div>
											</div>
										) : null}
									</>
								);
							})()}
							<div className="space-y-2 border-t pt-4">
								<button
									type="button"
									onClick={() => setShowNewKeyRestrictions((open) => !open)}
									className="flex w-full items-center justify-between text-sm font-medium hover:opacity-80"
									aria-expanded={showNewKeyRestrictions}
								>
									<span className="flex items-center gap-2">
										<SlidersHorizontal className="h-4 w-4" />
										Restrictions (optional)
									</span>
									<ChevronDown
										className={`h-4 w-4 transition-transform ${showNewKeyRestrictions ? "rotate-180" : ""}`}
									/>
								</button>
								{showNewKeyRestrictions ? (
									<ApiKeyRestrictionsEditor
										idPrefix="new-key"
										value={newKeyRestrictions}
										onChange={setNewKeyRestrictions}
										disabled={generateKeyMutation.isPending}
									/>
								) : (
									<ApiKeyRestrictionsSummary
										restrictions={newKeyRestrictions}
										accountNames={accountNames}
									/>
								)}
							</div>
							{generateKeyMutation.isError && (
								<div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
									<div className="flex items-start gap-2 text-destructive">
										<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
										<span className="text-sm">
											{generateKeyMutation.error?.message ??
												"Failed to generate API key."}
										</span>
									</div>
								</div>
							)}
						</div>
						<DialogFooter>
							<Button
								onClick={() => {
									setIsCreateDialogOpen(false);
									generateKeyMutation.reset();
								}}
								variant="outline"
							>
								Cancel
							</Button>
							<Button
								onClick={handleGenerateKey}
								disabled={!newKeyName.trim() || generateKeyMutation.isPending}
							>
								{generateKeyMutation.isPending
									? "Generating..."
									: "Generate Key"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			{/* API Keys List */}
			<Card>
				<CardHeader>
					<CardTitle>Your API Keys</CardTitle>
					<CardDescription>
						{apiKeys.length === 0
							? "No API keys have been created yet."
							: `You have ${apiKeys.length} API key${apiKeys.length === 1 ? "" : "s"}.`}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{(updateRoleMutation.isError || toggleKeyMutation.isError) && (
						<div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
							<div className="flex items-start gap-2 text-destructive">
								<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
								<span className="text-sm flex-1">
									{updateRoleMutation.error?.message ??
										toggleKeyMutation.error?.message ??
										"Operation failed."}
								</span>
								<button
									type="button"
									onClick={() => {
										updateRoleMutation.reset();
										toggleKeyMutation.reset();
									}}
									className="shrink-0 hover:opacity-70"
									aria-label="Dismiss error"
								>
									<X className="h-4 w-4" />
								</button>
							</div>
						</div>
					)}
					{isLoadingKeys ? (
						<div className="text-center py-8">Loading API keys...</div>
					) : apiKeys.length === 0 ? (
						<div className="text-center py-8 text-muted-foreground">
							<Shield className="h-12 w-12 mx-auto mb-4 opacity-50" />
							<p>No API keys configured</p>
							<p className="text-sm">
								API authentication will be disabled until you create your first
								key.
							</p>
						</div>
					) : (
						<div className="space-y-4">
							{apiKeys.map((key) => (
								<div
									key={key.id}
									className="flex items-center justify-between p-4 border rounded-lg"
								>
									<div className="flex-1">
										<div className="flex items-center gap-2">
											<h3 className="font-medium">{key.name}</h3>
											<div
												className={`px-2 py-1 rounded text-xs font-medium ${
													key.isActive
														? "bg-green-100 text-green-800"
														: "bg-gray-100 text-gray-600"
												}`}
											>
												{key.isActive ? "Active" : "Disabled"}
											</div>
											{/*
											 * One menu per row. The role items are disabled for the
											 * first key (which must stay admin), but the menu itself
											 * is always rendered so that key can still have its
											 * restrictions edited.
											 */}
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<button
														type="button"
														className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium cursor-pointer hover:opacity-80 ${
															key.role === "admin"
																? "bg-amber-100 text-amber-800"
																: "bg-blue-100 text-blue-800"
														}`}
														disabled={updateRoleMutation.isPending}
													>
														{key.role === "admin" ? "Admin" : "API-only"}
														<ChevronDown className="h-3 w-3" />
													</button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="start">
													<DropdownMenuItem
														onClick={() => handleUpdateRole(key, "admin")}
														disabled={
															key.role === "admin" || !canChangeRole(key)
														}
													>
														<Shield className="h-4 w-4 mr-2" />
														Admin (dashboard access)
													</DropdownMenuItem>
													<DropdownMenuItem
														onClick={() => handleUpdateRole(key, "api-only")}
														disabled={
															key.role === "api-only" || !canChangeRole(key)
														}
														title={
															canChangeRole(key)
																? undefined
																: "First API key must remain admin"
														}
													>
														API-only (proxy access)
													</DropdownMenuItem>
													<DropdownMenuSeparator />
													<DropdownMenuItem
														onClick={() => handleEditRestrictions(key)}
													>
														<SlidersHorizontal className="h-4 w-4 mr-2" />
														Edit restrictions
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</div>
										<div className="text-sm text-muted-foreground mt-1">
											Key ends with:{" "}
											<code className="bg-muted px-1 rounded">
												{key.prefixLast8}
											</code>
										</div>
										<div className="text-xs text-muted-foreground mt-1">
											Created{" "}
											{formatDistanceToNow(new Date(key.createdAt), {
												addSuffix: true,
											})}
											{key.lastUsed && (
												<>
													{" • "}Last used{" "}
													{formatDistanceToNow(new Date(key.lastUsed), {
														addSuffix: true,
													})}
												</>
											)}
											{" • "}Used {key.usageCount} time
											{key.usageCount !== 1 ? "s" : ""}
										</div>
										<div className="mt-2">
											<ApiKeyRestrictionsSummary
												restrictions={restrictionsOf(key)}
												accountNames={accountNames}
											/>
										</div>
									</div>
									<div className="flex items-center gap-2">
										<CopyButton
											variant="outline"
											size="sm"
											value={key.prefixLast8}
										/>
										<Button
											variant="outline"
											size="sm"
											onClick={() => handleToggleKey(key, !key.isActive)}
											disabled={toggleKeyMutation.isPending}
										>
											{key.isActive ? (
												<ToggleLeft className="h-4 w-4" />
											) : (
												<ToggleRight className="h-4 w-4" />
											)}
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={() => handleDeleteKey(key)}
											disabled={deleteKeyMutation.isPending}
										>
											<Trash2 className="h-4 w-4 text-destructive" />
										</Button>
									</div>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Generated Key Dialog */}
			<Dialog
				open={!!generatedKey}
				onOpenChange={(open) => {
					if (!open) {
						setGeneratedKey(null);
						// Trigger auth dialog when closing so user can authenticate
						window.dispatchEvent(new CustomEvent("auth-required"));
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>API Key Generated</DialogTitle>
						<DialogDescription>
							Your API key has been generated. Save it securely now - it won't
							be shown again.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label>API Key</Label>
							<div className="flex items-center gap-2">
								<code className="flex-1 p-3 bg-muted rounded text-sm font-mono break-all">
									{generatedKey}
								</code>
								<CopyButton
									variant="outline"
									size="sm"
									value={generatedKey ?? ""}
								/>
							</div>
						</div>
						<div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
							<div className="flex items-center gap-2 text-yellow-800">
								<AlertTriangle className="h-5 w-5" />
								<span className="font-medium">Important:</span>
							</div>
							<p className="text-sm text-yellow-700 mt-1">
								Save this API key in a secure location. You won't be able to see
								it again after closing this dialog.
							</p>
						</div>
					</div>
					<DialogFooter>
						<Button onClick={handleSavedKey} variant="outline">
							I've saved the key
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation Dialog */}
			<Dialog
				open={isDeleteDialogOpen}
				onOpenChange={(open) => {
					setIsDeleteDialogOpen(open);
					if (!open) deleteKeyMutation.reset();
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete API Key</DialogTitle>
						<DialogDescription>
							Are you sure you want to delete the API key "{selectedKey?.name}"?
							This action cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<div className="py-4">
						<p className="text-sm text-muted-foreground">
							Deleting this API key will immediately invalidate it, and any
							applications using it will no longer be able to authenticate.
						</p>
					</div>
					{deleteKeyMutation.isError && (
						<div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
							<div className="flex items-start gap-2 text-destructive">
								<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
								<span className="text-sm">
									{deleteKeyMutation.error?.message ??
										"Failed to delete API key."}
								</span>
							</div>
						</div>
					)}
					<DialogFooter>
						<Button
							onClick={() => {
								setIsDeleteDialogOpen(false);
								deleteKeyMutation.reset();
							}}
							variant="outline"
						>
							Cancel
						</Button>
						<Button
							onClick={confirmDeleteKey}
							variant="destructive"
							disabled={deleteKeyMutation.isPending}
						>
							{deleteKeyMutation.isPending ? "Deleting..." : "Delete Key"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Edit Restrictions Dialog */}
			<Dialog
				open={!!restrictionsKey}
				onOpenChange={(open) => {
					if (!open) {
						setRestrictionsKey(null);
						updateRestrictionsMutation.reset();
					}
				}}
			>
				<DialogContent className="max-h-[85vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>
							Restrictions for "{restrictionsKey?.name}"
						</DialogTitle>
						<DialogDescription>
							Limit which accounts, models and providers this key may route to.
							Requires an admin key.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<ApiKeyRestrictionsEditor
							idPrefix={`key-${restrictionsKey?.id ?? "none"}`}
							value={restrictionsDraft}
							onChange={setRestrictionsDraft}
							disabled={updateRestrictionsMutation.isPending}
						/>
						{updateRestrictionsMutation.isError && (
							<div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
								<div className="flex items-start gap-2 text-destructive">
									<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
									<span className="text-sm">
										{updateRestrictionsMutation.error?.message ??
											"Failed to update restrictions."}
									</span>
								</div>
							</div>
						)}
					</div>
					<DialogFooter>
						<Button
							onClick={() => {
								setRestrictionsKey(null);
								updateRestrictionsMutation.reset();
							}}
							variant="outline"
						>
							Cancel
						</Button>
						<Button
							onClick={confirmRestrictions}
							disabled={updateRestrictionsMutation.isPending}
						>
							{updateRestrictionsMutation.isPending
								? "Saving..."
								: "Save restrictions"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
