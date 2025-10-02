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
		mode: "max" | "console" | "zai";
		tier: number;
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
		tier: number;
		priority: number;
		customEndpoint?: string;
	}) => Promise<void>;
	onCancel: () => void;
	onSuccess: () => void;
	onError: (error: string) => void;
}

export function AccountAddForm({
	onAddAccount,
	onCompleteAccount,
	onAddZaiAccount,
	onCancel,
	onSuccess,
	onError,
}: AccountAddFormProps) {
	const [authStep, setAuthStep] = useState<"form" | "code">("form");
	const [authCode, setAuthCode] = useState("");
	const [sessionId, setSessionId] = useState("");
	const [newAccount, setNewAccount] = useState({
		name: "",
		mode: "max" as "max" | "console" | "zai",
		tier: 1,
		priority: 0,
		apiKey: "",
		customEndpoint: "",
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
			mode: newAccount.mode as "max" | "console" | "zai",
			tier: newAccount.tier,
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
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "max",
				tier: 1,
				priority: 0,
				apiKey: "",
				customEndpoint: "",
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
			mode: "max",
			tier: 1,
			priority: 0,
			apiKey: "",
			customEndpoint: "",
		});
		onSuccess();
	};

	const handleCancel = () => {
		setAuthStep("form");
		setAuthCode("");
		setSessionId("");
		setNewAccount({
			name: "",
			mode: "max",
			tier: 1,
			priority: 0,
			apiKey: "",
			customEndpoint: "",
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
							onValueChange={(value: "max" | "console" | "zai") =>
								setNewAccount({ ...newAccount, mode: value })
							}
						>
							<SelectTrigger id="mode">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="max">Max (Recommended)</SelectItem>
								<SelectItem value="console">Console</SelectItem>
								<SelectItem value="zai">z.ai (API Key)</SelectItem>
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
					{(newAccount.mode === "max" ||
						newAccount.mode === "console" ||
						newAccount.mode === "zai") && (
						<div className="space-y-2">
							<Label htmlFor="customEndpoint">Custom Endpoint (Optional)</Label>
							<Input
								id="customEndpoint"
								value={newAccount.customEndpoint}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setNewAccount({
										...newAccount,
										customEndpoint: (e.target as HTMLInputElement).value,
									})
								}
								placeholder={
									newAccount.mode === "zai"
										? "https://api.z.ai/api/anthropic"
										: "https://api.anthropic.com"
								}
							/>
							<p className="text-xs text-muted-foreground">
								Leave empty to use default endpoint. Must be a valid URL.
							</p>
						</div>
					)}
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
