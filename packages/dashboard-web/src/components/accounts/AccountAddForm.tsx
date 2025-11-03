import { useState } from "react";
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
			| "nanogpt"
			| "anthropic-compatible"
			| "openai-compatible";
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
	onAddOpenAIAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddNanoGPTAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
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
	onAddOpenAIAccount,
	onAddNanoGPTAccount,
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
			| "nanogpt"
			| "anthropic-compatible"
			| "openai-compatible",
		priority: 0,
		apiKey: "",
		customEndpoint: "",
		opusModel: "",
		sonnetModel: "",
		haikuModel: "",
	});

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
				| "nanogpt"
				| "anthropic-compatible"
				| "openai-compatible",
			priority: newAccount.priority,
			...(newAccount.customEndpoint && {
				customEndpoint: newAccount.customEndpoint.trim(),
			}),
		};

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

			// Build model mappings object
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;

			// For NanoGPT accounts, we don't need OAuth flow and no custom endpoint
			await onAddNanoGPTAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
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
		if (!authCode) {
			onError("Authorization code is required");
			return;
		}
		// Step 2: Complete OAuth flow
		await onCompleteAccount({
			sessionId,
			code: authCode,
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
						<p className="text-xs text-muted-foreground">
							Valid characters: letters, numbers, spaces, hyphens (-),
							underscores (_), dots (.), and @ symbols. Maximum 100 characters.
						</p>
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
									| "nanogpt"
									| "anthropic-compatible"
									| "openai-compatible",
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
								<SelectItem value="zai">z.ai (API Key)</SelectItem>
								<SelectItem value="minimax">Minimax (API Key)</SelectItem>
								<SelectItem value="nanogpt">
									NanoGPT (API Key with subscription)
								</SelectItem>
								<SelectItem value="anthropic-compatible">
									Anthropic-Compatible (API Key)
								</SelectItem>
								<SelectItem value="openai-compatible">
									OpenAI-Compatible (API Key)
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
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
								setNewAccount({ ...newAccount, priority: parseInt(value) })
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
