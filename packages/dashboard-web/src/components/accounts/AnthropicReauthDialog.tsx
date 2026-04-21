import { useState } from "react";
import type { Account } from "../../api";
import { api } from "../../api";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface AnthropicReauthDialogProps {
	account: Account | null;
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

type Step = "idle" | "awaiting-code" | "submitting" | "complete" | "error";

export function AnthropicReauthDialog({
	account,
	isOpen,
	onClose,
	onSuccess,
}: AnthropicReauthDialogProps) {
	const [step, setStep] = useState<Step>("idle");
	const [authUrl, setAuthUrl] = useState("");
	const [sessionId, setSessionId] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState("");

	const handleStart = async () => {
		if (!account) return;
		setStep("awaiting-code");
		setError("");

		try {
			const result = await api.initAnthropicReauth(account.id);
			setAuthUrl(result.authUrl);
			setSessionId(result.sessionId);
			window.open(result.authUrl, "_blank");
		} catch (err) {
			setStep("error");
			setError(
				err instanceof Error ? err.message : "Failed to start authentication",
			);
		}
	};

	const handleComplete = async () => {
		if (!sessionId || !code.trim()) return;
		setStep("submitting");
		setError("");

		try {
			await api.completeAnthropicReauth(sessionId, code.trim());
			setStep("complete");
			setTimeout(() => {
				onSuccess();
				handleClose();
			}, 1500);
		} catch (err) {
			setStep("error");
			setError(
				err instanceof Error
					? err.message
					: "Failed to complete authentication",
			);
		}
	};

	const handleClose = () => {
		setStep("idle");
		setAuthUrl("");
		setSessionId("");
		setCode("");
		setError("");
		onClose();
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Re-authenticate Anthropic Account</DialogTitle>
					<DialogDescription>
						{account?.name
							? `Re-authenticate "${account.name}". All account metadata (usage stats, priority, settings) will be preserved.`
							: "Re-authenticate Anthropic account."}
					</DialogDescription>
				</DialogHeader>

				<div className="py-4">
					{step === "idle" && (
						<p className="text-sm text-muted-foreground">
							Click the button below to start the Anthropic OAuth flow. A
							browser window will open for you to authorize. After approving,
							paste the authorization code here.
						</p>
					)}

					{step === "awaiting-code" && (
						<div className="space-y-4">
							<p className="text-sm text-muted-foreground">
								A browser window has opened for authorization. After approving,
								copy the authorization code and paste it below.
							</p>
							{authUrl && (
								<a
									href={authUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="text-sm text-primary underline break-all"
								>
									Open authorization page
								</a>
							)}
							<div className="space-y-2">
								<Label htmlFor="auth-code">Authorization Code</Label>
								<Input
									id="auth-code"
									placeholder="Paste the authorization code here"
									value={code}
									onChange={(e) => setCode(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && code.trim()) {
											handleComplete();
										}
									}}
								/>
							</div>
						</div>
					)}

					{step === "submitting" && (
						<p className="text-sm text-muted-foreground">
							Completing re-authentication...
						</p>
					)}

					{step === "complete" && (
						<p className="text-sm text-green-600">
							Re-authentication successful! Tokens updated.
						</p>
					)}

					{step === "error" && (
						<div className="space-y-2">
							<p className="text-sm text-destructive">{error}</p>
						</div>
					)}
				</div>

				<DialogFooter>
					{step === "idle" && (
						<Button onClick={handleStart}>Start Re-authentication</Button>
					)}
					{step === "awaiting-code" && (
						<Button onClick={handleComplete} disabled={!code.trim()}>
							Complete Re-authentication
						</Button>
					)}
					{step === "error" && <Button onClick={handleStart}>Try Again</Button>}
					<Button variant="outline" onClick={handleClose}>
						{step === "complete" ? "Close" : "Cancel"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
