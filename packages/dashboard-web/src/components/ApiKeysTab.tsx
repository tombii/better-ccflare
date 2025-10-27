import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangle,
	Copy,
	Plus,
	Shield,
	ToggleLeft,
	ToggleRight,
	Trash2,
} from "lucide-react";
import { useState } from "react";
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
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ApiKey {
	id: string;
	name: string;
	prefixLast8: string;
	createdAt: string;
	lastUsed: string | null;
	usageCount: number;
	isActive: boolean;
}

interface ApiKeysResponse {
	success: boolean;
	data: ApiKey[];
	count: number;
}

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
	data: {
		id: string;
		name: string;
		apiKey: string; // Full API key shown only once
		prefixLast8: string;
		createdAt: string;
	};
}

export function ApiKeysTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [newKeyName, setNewKeyName] = useState("");
	const [selectedKey, setSelectedKey] = useState<ApiKey | null>(null);
	const [generatedKey, setGeneratedKey] = useState<string | null>(null);

	const queryClient = useQueryClient();

	// Fetch API keys
	const {
		data: apiKeysResponse,
		isLoading: isLoadingKeys,
		error: keysError,
	} = useQuery<ApiKeysResponse>({
		queryKey: ["api-keys"],
		queryFn: async () => {
			const response = await fetch("/api/api-keys");
			if (!response.ok) {
				throw new Error("Failed to fetch API keys");
			}
			return response.json();
		},
	});

	// Fetch API key statistics
	const {
		data: statsResponse,
		isLoading: isLoadingStats,
		error: statsError,
	} = useQuery<ApiKeyStatsResponse>({
		queryKey: ["api-keys-stats"],
		queryFn: async () => {
			const response = await fetch("/api/api-keys/stats");
			if (!response.ok) {
				throw new Error("Failed to fetch API key statistics");
			}
			return response.json();
		},
	});

	// Generate API key mutation
	const generateKeyMutation = useMutation({
		mutationFn: async (name: string) => {
			const response = await fetch("/api/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name }),
			});
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.message || "Failed to generate API key");
			}
			const result: ApiKeyGenerationResponse = await response.json();
			return result.data;
		},
		onSuccess: (data) => {
			setGeneratedKey(data.apiKey);
			setNewKeyName("");
			setIsCreateDialogOpen(false);
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
		onError: (error: Error) => {
			console.error("Failed to generate API key:", error);
		},
	});

	// Toggle API key status mutation
	const toggleKeyMutation = useMutation({
		mutationFn: async ({ name, enable }: { name: string; enable: boolean }) => {
			const endpoint = enable
				? `/api/api-keys/${encodeURIComponent(name)}/enable`
				: `/api/api-keys/${encodeURIComponent(name)}/disable`;
			const response = await fetch(endpoint, { method: "POST" });
			if (!response.ok) {
				const error = await response.json();
				throw new Error(
					error.message || `Failed to ${enable ? "enable" : "disable"} API key`,
				);
			}
			return response.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
	});

	// Delete API key mutation
	const deleteKeyMutation = useMutation({
		mutationFn: async (name: string) => {
			const response = await fetch(
				`/api/api-keys/${encodeURIComponent(name)}`,
				{
					method: "DELETE",
				},
			);
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.message || "Failed to delete API key");
			}
			return response.json();
		},
		onSuccess: () => {
			setSelectedKey(null);
			setIsDeleteDialogOpen(false);
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
	});

	const handleGenerateKey = () => {
		if (!newKeyName.trim()) return;
		generateKeyMutation.mutate(newKeyName.trim());
	};

	const handleToggleKey = (key: ApiKey, enable: boolean) => {
		toggleKeyMutation.mutate({ name: key.name, enable });
	};

	const handleDeleteKey = (key: ApiKey) => {
		setSelectedKey(key);
		setIsDeleteDialogOpen(true);
	};

	const confirmDeleteKey = () => {
		if (selectedKey) {
			deleteKeyMutation.mutate(selectedKey.name);
		}
	};

	const copyToClipboard = (text: string) => {
		navigator.clipboard.writeText(text);
	};

	const stats = statsResponse?.data;
	const apiKeys = apiKeysResponse?.data || [];

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
				<Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
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
						</div>
						<DialogFooter>
							<Button
								onClick={() => setIsCreateDialogOpen(false)}
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
									</div>
									<div className="flex items-center gap-2">
										<Button
											variant="outline"
											size="sm"
											onClick={() => copyToClipboard(key.prefixLast8)}
										>
											<Copy className="h-4 w-4" />
										</Button>
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
					if (!open) setGeneratedKey(null);
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
								<Button
									variant="outline"
									size="sm"
									onClick={() => copyToClipboard(generatedKey!)}
								>
									<Copy className="h-4 w-4" />
								</Button>
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
						<Button onClick={() => setGeneratedKey(null)} variant="outline">
							I've saved the key
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation Dialog */}
			<Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
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
					<DialogFooter>
						<Button
							onClick={() => setIsDeleteDialogOpen(false)}
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
		</div>
	);
}
