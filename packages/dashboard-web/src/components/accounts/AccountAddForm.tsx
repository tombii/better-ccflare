import { useEffect, useState } from "react";
import { api } from "../../api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface AccountAddFormProps {
	onAddAccount: (params: {
		name: string;
		mode:
			| "claude-oauth"
			| "console"
			| "zai"
			| "minimax"
			| "anthropic-compatible"
			| "openai-compatible"
			| "nanogpt"
			| "vertex-ai"
			| "bedrock";
		priority: number;
		customEndpoint?: string;
	}) => Promise<{ authUrl: string; sessionId: string }>;
	onCompleteAccount: (params: {
		sessionId: string;
		code: string;
	}) => Promise<void>;
	onAddZaiAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
	}) => Promise<void>;
	onAddMinimaxAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
	}) => Promise<void>;
	onAddAnthropicCompatibleAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddNanoGPTAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddOpenAIAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddVertexAIAccount: (params: {
		name: string;
		projectId: string;
		region: string;
		priority: number;
	}) => Promise<void>;
	onAddBedrockAccount: (params: {
		name: string;
		profile: string;
		region: string;
		priority: number;
		cross_region_mode?: "geographic" | "global" | "regional";
	}) => Promise<void>;
	onCancel: () => void;
	onSuccess: () => void;
	onError: (error: string) => void;
}

export function AccountAddForm({
	onAddAccount,
	onCompleteAccount,
	onAddZaiAccount,
	onAddMinimaxAccount,
	onAddAnthropicCompatibleAccount,
	onAddNanoGPTAccount,
	onAddOpenAIAccount,
	onAddVertexAIAccount,
	onAddBedrockAccount,
	onCancel,
	onSuccess,
	onError,
}: AccountAddFormProps) {
	const [authStep, setAuthStep] = useState<"form" | "code">("form");
	const [authCode, setAuthCode] = useState("");
	const [sessionId, setSessionId] = useState("");
	const [newAccount, setNewAccount] = useState({
		name: "",
		mode: "claude-oauth" as
			| "claude-oauth"
			| "console"
			| "zai"
			| "minimax"
			| "anthropic-compatible"
			| "openai-compatible"
			| "nanogpt"
			| "vertex-ai"
			| "bedrock",
		priority: 0,
		apiKey: "",
		customEndpoint: "",
		projectId: "",
		region: "global",
		profile: "",
		awsRegion: "",
		crossRegionMode: "geographic" as "geographic" | "global" | "regional",
		opusModel: "",
		sonnetModel: "",
		haikuModel: "",
	});

	const [awsProfiles, setAwsProfiles] = useState<
		Array<{ name: string; region: string | null }>
	>([]);
	const [loadingProfiles, setLoadingProfiles] = useState(false);

	// Load AWS profiles when bedrock mode is selected
	useEffect(() => {
		if (newAccount.mode === "bedrock") {
			setLoadingProfiles(true);
			api
				.getAwsProfiles()
				.then((profiles) => {
					setAwsProfiles(profiles);
				})
				.catch((error) => {
					console.error("Failed to load AWS profiles:", error);
					setAwsProfiles([]);
				})
				.finally(() => {
					setLoadingProfiles(false);
				});
		}
	}, [newAccount.mode]);

	const validateCustomEndpoint = (endpoint: string): boolean => {
		if (!endpoint) return true; // Empty is fine (use default)
		try {
			new URL(endpoint);
			return true;
		} catch {
			return false;
		}
	};

	const handleAddAccount = async () => {
		if (!newAccount.name) {
			onError("Account name is required");
			return;
		}

		// Validate custom endpoint if provided
		if (
			newAccount.customEndpoint &&
			!validateCustomEndpoint(newAccount.customEndpoint)
		) {
			onError(
				"Custom endpoint must be a valid URL (e.g., https://api.anthropic.com)",
			);
			return;
		}

		const accountParams = {
			name: newAccount.name,
			mode: newAccount.mode as
				| "claude-oauth"
				| "console"
				| "zai"
				| "minimax"
				| "anthropic-compatible"
				| "openai-compatible"
				| "bedrock",
			priority: newAccount.priority,
			...(newAccount.customEndpoint && {
				customEndpoint: newAccount.customEndpoint.trim(),
			}),
		};

		if (newAccount.mode === "vertex-ai") {
			if (!newAccount.projectId) {
				onError("Google Cloud Project ID is required for Vertex AI accounts");
				return;
			}
			// For Vertex AI accounts, we don't need OAuth flow
			await onAddVertexAIAccount({
				name: newAccount.name,
				projectId: newAccount.projectId.trim(),
				region: newAccount.region || "global",
				priority: newAccount.priority,
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				crossRegionMode: "geographic",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "bedrock") {
			if (!newAccount.profile) {
				onError("AWS profile is required for Bedrock accounts");
				return;
			}
			if (!newAccount.awsRegion) {
				onError(
					"Region not found for selected profile. Configure ~/.aws/config",
				);
				return;
			}
			// For Bedrock accounts, we don't need OAuth flow
			await onAddBedrockAccount({
				name: newAccount.name,
				profile: newAccount.profile,
				region: newAccount.awsRegion,
				priority: newAccount.priority,
				cross_region_mode: newAccount.crossRegionMode,
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				crossRegionMode: "geographic",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "zai") {
			if (!newAccount.apiKey) {
				onError("API key is required for z.ai accounts");
				return;
			}
			// For z.ai accounts, we don't need OAuth flow
			await onAddZaiAccount({
				...accountParams,
				apiKey: newAccount.apiKey,
				...(newAccount.customEndpoint && {
					customEndpoint: newAccount.customEndpoint.trim(),
				}),
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				crossRegionMode: "geographic",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "minimax") {
			if (!newAccount.apiKey) {
				onError("API key is required for Minimax accounts");
				return;
			}
			// For Minimax accounts, we don't need OAuth flow and use default tier
			await onAddMinimaxAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				crossRegionMode: "geographic",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "nanogpt") {
			if (!newAccount.apiKey) {
				onError("API key is required for NanoGPT accounts");
				return;
			}
			// Build model mappings from form fields
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) {
				modelMappings.opus = newAccount.opusModel;
			}
			if (newAccount.sonnetModel) {
				modelMappings.sonnet = newAccount.sonnetModel;
			}
			if (newAccount.haikuModel) {
				modelMappings.haiku = newAccount.haikuModel;
			}
			// For NanoGPT accounts, we don't need OAuth flow
			await onAddNanoGPTAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint || undefined,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				crossRegionMode: "geographic",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "anthropic-compatible") {
			if (!newAccount.apiKey) {
				onError("API key is required for Anthropic-compatible accounts");
				return;
			}
			// Build model mappings object
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;

			// For Anthropic-compatible accounts, we don't need OAuth flow and use default tier
			await onAddAnthropicCompatibleAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint || undefined,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				crossRegionMode: "geographic",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "openai-compatible") {
			if (!newAccount.apiKey) {
				onError("API key is required for OpenAI-compatible accounts");
				return;
			}
			if (!newAccount.customEndpoint) {
				onError("Endpoint URL is required for OpenAI-compatible accounts");
				return;
			}

			// Build model mappings object
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;

			// For OpenAI-compatible accounts, we don't need OAuth flow
			await onAddOpenAIAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint.trim(),
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});

			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				crossRegionMode: "geographic",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		// Step 1: Initialize OAuth flow for Max/Console accounts
		const { authUrl, sessionId } = await onAddAccount(accountParams);
		setSessionId(sessionId);

		// Open auth URL in new tab
		if (typeof window !== "undefined") {
			window.open(authUrl, "_blank");
		}

		// Move to code entry step
		setAuthStep("code");
	};

	const handleCodeSubmit = async () => {
		const trimmedCode = authCode.trim();
		if (!trimmedCode) {
			onError("Authorization code is required");
			return;
		}
		// Step 2: Complete OAuth flow
		await onCompleteAccount({
			sessionId,
			code: trimmedCode,
		});

		// Success! Reset form
		setAuthStep("form");
		setAuthCode("");
		setSessionId("");
		setNewAccount({
			name: "",
			mode: "claude-oauth",
			priority: 0,
			apiKey: "",
			customEndpoint: "",
			projectId: "",
			region: "global",
			profile: "",
			awsRegion: "",
			crossRegionMode: "geographic",
			opusModel: "",
			sonnetModel: "",
			haikuModel: "",
		});
		onSuccess();
	};

	const handleCancel = () => {
		setAuthStep("form");
		setAuthCode("");
		setSessionId("");
		setNewAccount({
			name: "",
			mode: "claude-oauth",
			priority: 0,
			apiKey: "",
			customEndpoint: "",
			projectId: "",
			region: "global",
			profile: "",
			awsRegion: "",
			crossRegionMode: "geographic",
			opusModel: "",
			sonnetModel: "",
			haikuModel: "",
		});
		onCancel();
	};

	return (
		<div className="space-y-4 mb-6 p-4 border rounded-lg">
			<h4 className="font-medium">
				{authStep === "form" ? "Add New Account" : "Enter Authorization Code"}
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
							placeholder="e.g., work-account or user@example.com"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="mode">Mode</Label>
						<Select
							value={newAccount.mode}
							onValueChange={(
								value:
									| "claude-oauth"
									| "console"
									| "zai"
									| "minimax"
									| "anthropic-compatible"
									| "openai-compatible"
									| "bedrock",
							) => setNewAccount({ ...newAccount, mode: value })}
						>
							<SelectTrigger id="mode">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="claude-oauth">
									Claude CLI OAuth (Recommended)
								</SelectItem>
								<SelectItem value="console">Claude API</SelectItem>
								<SelectItem value="vertex-ai">
									Vertex AI (Google Cloud)
								</SelectItem>
								<SelectItem value="bedrock">AWS Bedrock</SelectItem>
								<SelectItem value="zai">z.ai (API Key)</SelectItem>
								<SelectItem value="minimax">Minimax (API Key)</SelectItem>
								<SelectItem value="nanogpt">NanoGPT (API Key)</SelectItem>
								<SelectItem value="anthropic-compatible">
									Anthropic-Compatible (API Key)
								</SelectItem>
								<SelectItem value="openai-compatible">
									OpenAI-Compatible (API Key)
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{newAccount.mode === "vertex-ai" && (
						<>
							<div className="space-y-2">
								<Label htmlFor="projectId">Google Cloud Project ID</Label>
								<Input
									id="projectId"
									value={newAccount.projectId}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											projectId: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="your-project-id"
								/>
								<p className="text-xs text-muted-foreground">
									Your Google Cloud project ID where Vertex AI is enabled
								</p>
							</div>
							<div className="space-y-2">
								<Label htmlFor="region">Region</Label>
								<Select
									value={newAccount.region}
									onValueChange={(value: string) =>
										setNewAccount({ ...newAccount, region: value })
									}
								>
									<SelectTrigger id="region">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="global">Global (Recommended)</SelectItem>
										<SelectItem value="us-east5">us-east5</SelectItem>
										<SelectItem value="us-central1">us-central1</SelectItem>
										<SelectItem value="europe-west1">europe-west1</SelectItem>
										<SelectItem value="europe-west4">europe-west4</SelectItem>
										<SelectItem value="asia-southeast1">
											asia-southeast1
										</SelectItem>
									</SelectContent>
								</Select>
								<p className="text-xs text-muted-foreground">
									Global for best availability, regional for data residency
								</p>
							</div>
							<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg">
								<p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-1">
									Authentication Required
								</p>
								<p className="text-xs text-blue-800 dark:text-blue-200">
									Vertex AI uses Google Cloud credentials. Ensure you've run:{" "}
									<code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">
										gcloud auth application-default login
									</code>
								</p>
							</div>
						</>
					)}
					{newAccount.mode === "bedrock" && (
						<>
							{awsProfiles.length === 0 && !loadingProfiles && (
								<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg">
									<p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-1">
										No AWS profiles found
									</p>
									<p className="text-xs text-blue-800 dark:text-blue-200">
										Run{" "}
										<code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">
											aws configure
										</code>{" "}
										to set up profiles.
									</p>
								</div>
							)}
							{awsProfiles.length > 0 && (
								<>
									<div className="space-y-2">
										<Label htmlFor="awsProfile">AWS Profile</Label>
										<Select
											value={newAccount.profile}
											onValueChange={(value: string) => {
												const selectedProfile = awsProfiles.find(
													(p) => p.name === value,
												);
												setNewAccount({
													...newAccount,
													profile: value,
													awsRegion: selectedProfile?.region || "",
												});
											}}
										>
											<SelectTrigger id="awsProfile">
												<SelectValue placeholder="Select AWS profile" />
											</SelectTrigger>
											<SelectContent>
												{awsProfiles.map((profile) => (
													<SelectItem key={profile.name} value={profile.name}>
														{profile.name}
														{profile.region && ` (${profile.region})`}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<p className="text-xs text-muted-foreground">
											Your AWS profile from ~/.aws/credentials
										</p>
									</div>
									<div className="space-y-2">
										<Label htmlFor="awsRegion">Region (Auto-detected)</Label>
										<Input
											id="awsRegion"
											value={newAccount.awsRegion}
											disabled
											placeholder="Select profile to detect region"
										/>
										<p className="text-xs text-muted-foreground">
											Region from ~/.aws/config for selected profile
										</p>
										{newAccount.profile &&
											!newAccount.awsRegion &&
											!loadingProfiles && (
												<p className="text-xs text-yellow-600 dark:text-yellow-400">
													No default region found for this profile. Configure
													region in ~/.aws/config
												</p>
											)}
									</div>
									<div className="space-y-2">
										<Label htmlFor="crossRegionMode">Cross-Region Mode</Label>
										<Select
											value={newAccount.crossRegionMode}
											onValueChange={(
												value: "geographic" | "global" | "regional",
											) =>
												setNewAccount({ ...newAccount, crossRegionMode: value })
											}
										>
											<SelectTrigger id="crossRegionMode">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="geographic">
													Geographic (default - routes within your region's
													geography)
												</SelectItem>
												<SelectItem value="global">
													Global (routes globally, ~10% cost savings, premium
													models only)
												</SelectItem>
												<SelectItem value="regional">
													Regional (single region, no failover)
												</SelectItem>
											</SelectContent>
										</Select>
										<p className="text-xs text-muted-foreground">
											Controls how Bedrock routes requests for cross-region
											inference
										</p>
									</div>
									<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg">
										<p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-1">
											Authentication Required
										</p>
										<p className="text-xs text-blue-800 dark:text-blue-200">
											Bedrock uses AWS credentials from the selected profile.
											Ensure your credentials are configured.
										</p>
									</div>
								</>
							)}
						</>
					)}
					{newAccount.mode === "zai" && (
						<div className="space-y-2">
							<Label htmlFor="apiKey">z.ai API Key</Label>
							<Input
								id="apiKey"
								type="password"
								value={newAccount.apiKey}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setNewAccount({
										...newAccount,
										apiKey: (e.target as HTMLInputElement).value,
									})
								}
								placeholder="Enter your z.ai API key"
							/>
						</div>
					)}
					{newAccount.mode === "minimax" && (
						<div className="space-y-2">
							<Label htmlFor="apiKey">Minimax API Key</Label>
							<Input
								id="apiKey"
								type="password"
								value={newAccount.apiKey}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setNewAccount({
										...newAccount,
										apiKey: (e.target as HTMLInputElement).value,
									})
								}
								placeholder="Enter your Minimax API key"
							/>
						</div>
					)}
					{newAccount.mode === "nanogpt" && (
						<>
							<div className="space-y-2">
								<Label htmlFor="apiKey">NanoGPT API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your NanoGPT API key"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="customEndpoint">
									Custom Endpoint (Optional)
								</Label>
								<Input
									id="customEndpoint"
									type="url"
									value={newAccount.customEndpoint}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											customEndpoint: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="https://nano-gpt.com/api (default)"
								/>
							</div>
							<div className="space-y-2">
								<Label className="text-sm font-medium">
									Model Mappings (Optional)
								</Label>
								<p className="text-xs text-muted-foreground">
									Map Anthropic model names to NanoGPT-specific models. Leave
									empty to use defaults.
								</p>
								<div className="space-y-2 pl-4">
									<div>
										<Label htmlFor="opusModel" className="text-sm">
											Opus Model
										</Label>
										<Input
											id="opusModel"
											value={newAccount.opusModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													opusModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="nanogpt-ultra (default)"
											className="mt-1"
										/>
									</div>
									<div>
										<Label htmlFor="sonnetModel" className="text-sm">
											Sonnet Model
										</Label>
										<Input
											id="sonnetModel"
											value={newAccount.sonnetModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													sonnetModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="nanogpt-pro (default)"
											className="mt-1"
										/>
									</div>
									<div>
										<Label htmlFor="haikuModel" className="text-sm">
											Haiku Model
										</Label>
										<Input
											id="haikuModel"
											value={newAccount.haikuModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													haikuModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="nanogpt-lite (default)"
											className="mt-1"
										/>
									</div>
								</div>
							</div>
						</>
					)}
					{newAccount.mode === "anthropic-compatible" && (
						<>
							<div className="space-y-2">
								<Label htmlFor="apiKey">Anthropic-Compatible API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your Anthropic-Compatible API key"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="customEndpoint">
									Custom Endpoint URL (Optional)
								</Label>
								<Input
									id="customEndpoint"
									type="url"
									value={newAccount.customEndpoint}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											customEndpoint: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="https://api.anthropic-compatible.com"
								/>
							</div>
							<div className="space-y-2">
								<Label>Model Mappings (Optional)</Label>
								<p className="text-xs text-muted-foreground mb-2">
									Map Anthropic model names to provider-specific models. Leave
									empty to use defaults.
								</p>
								<div className="space-y-2 pl-4">
									<div>
										<Label htmlFor="opusModel" className="text-sm">
											Opus Model
										</Label>
										<Input
											id="opusModel"
											value={newAccount.opusModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													opusModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="claude-3-opus-20240229 (default)"
											className="mt-1"
										/>
									</div>
									<div>
										<Label htmlFor="sonnetModel" className="text-sm">
											Sonnet Model
										</Label>
										<Input
											id="sonnetModel"
											value={newAccount.sonnetModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													sonnetModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="claude-3-sonnet-20240229 (default)"
											className="mt-1"
										/>
									</div>
									<div>
										<Label htmlFor="haikuModel" className="text-sm">
											Haiku Model
										</Label>
										<Input
											id="haikuModel"
											value={newAccount.haikuModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													haikuModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="claude-3-haiku-20240307 (default)"
											className="mt-1"
										/>
									</div>
								</div>
							</div>
						</>
					)}
					{newAccount.mode === "openai-compatible" && (
						<>
							<div className="space-y-2">
								<Label htmlFor="apiKey">API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your API key"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="endpoint">Endpoint URL</Label>
								<Input
									id="endpoint"
									value={newAccount.customEndpoint}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											customEndpoint: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="https://api.openrouter.ai/api/v1"
								/>
								<p className="text-xs text-muted-foreground">
									Enter the base URL for the OpenAI-compatible API
								</p>
							</div>
							<div className="space-y-2">
								<Label>Model Mappings (Optional)</Label>
								<p className="text-xs text-muted-foreground mb-2">
									Map Anthropic model names to provider-specific models. Leave
									empty to use defaults.
								</p>
								<div className="space-y-2 pl-4">
									<div>
										<Label htmlFor="opusModel" className="text-sm">
											Opus Model
										</Label>
										<Input
											id="opusModel"
											value={newAccount.opusModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													opusModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="openai/gpt-5 (default)"
											className="mt-1"
										/>
									</div>
									<div>
										<Label htmlFor="sonnetModel" className="text-sm">
											Sonnet Model
										</Label>
										<Input
											id="sonnetModel"
											value={newAccount.sonnetModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													sonnetModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="openai/gpt-5 (default)"
											className="mt-1"
										/>
									</div>
									<div>
										<Label htmlFor="haikuModel" className="text-sm">
											Haiku Model
										</Label>
										<Input
											id="haikuModel"
											value={newAccount.haikuModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													haikuModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="openai/gpt-5-mini (default)"
											className="mt-1"
										/>
									</div>
								</div>
							</div>
						</>
					)}
					{(newAccount.mode === "claude-oauth" ||
						newAccount.mode === "console") && (
						<div className="space-y-2">
							<Label htmlFor="customEndpoint">
								Custom Endpoint URL (Optional)
							</Label>
							<Input
								id="customEndpoint"
								type="url"
								value={newAccount.customEndpoint}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setNewAccount({
										...newAccount,
										customEndpoint: (e.target as HTMLInputElement).value,
									})
								}
								placeholder="https://api.anthropic.com"
							/>
							<p className="text-xs text-muted-foreground">
								Leave empty to use default Anthropic endpoint. Must be a valid
								URL.
							</p>
						</div>
					)}
					<div className="space-y-2">
						<Label htmlFor="priority">Priority</Label>
						<Select
							value={String(newAccount.priority)}
							onValueChange={(value: string) =>
								setNewAccount({ ...newAccount, priority: parseInt(value, 10) })
							}
						>
							<SelectTrigger id="priority">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="0">0 (Highest)</SelectItem>
								<SelectItem value="25">25 (High)</SelectItem>
								<SelectItem value="50">50 (Medium)</SelectItem>
								<SelectItem value="75">75 (Low)</SelectItem>
								<SelectItem value="100">100 (Lowest)</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</>
			)}
			{authStep === "form" ? (
				<div className="flex gap-2">
					<Button onClick={handleAddAccount}>Continue</Button>
					<Button variant="outline" onClick={handleCancel}>
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
						<Button variant="outline" onClick={handleCancel}>
							Cancel
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
