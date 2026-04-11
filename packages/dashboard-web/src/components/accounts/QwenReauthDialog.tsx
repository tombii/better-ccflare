import { useCallback, useEffect, useRef, useState } from "react";
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

interface QwenReauthDialogProps {
	account: Account | null;
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

type Step = "idle" | "pending" | "complete" | "error";

export function QwenReauthDialog({
	account,
	isOpen,
	onClose,
	onSuccess,
}: QwenReauthDialogProps) {
	const [step, setStep] = useState<Step>("idle");
	const [authUrl, setAuthUrl] = useState("");
	const [userCode, setUserCode] = useState("");
	const [error, setError] = useState("");
	const sessionIdRef = useRef<string>("");
	const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopPolling = useCallback(() => {
		if (pollIntervalRef.current !== null) {
			clearInterval(pollIntervalRef.current);
			pollIntervalRef.current = null;
		}
	}, []);

	// Clean up on unmount or close
	useEffect(() => {
		if (!isOpen) {
			stopPolling();
		}
		return () => stopPolling();
	}, [isOpen, stopPolling]);

	const handleStart = async () => {
		if (!account) return;
		setStep("pending");
		setError("");

		try {
			const result = await api.initQwenReauth({ accountId: account.id });
			sessionIdRef.current = result.sessionId;
			setAuthUrl(result.authUrl);
			setUserCode(result.userCode);

			window.open(result.authUrl, "_blank");

			pollIntervalRef.current = setInterval(async () => {
				try {
					const status = await api.getQwenAuthStatus(sessionIdRef.current);
					if (status.status === "complete") {
						stopPolling();
						setStep("complete");
						setTimeout(() => {
							onSuccess();
							handleClose();
						}, 1500);
					} else if (status.status === "error") {
						stopPolling();
						setStep("error");
						setError(status.error || "Authentication failed");
					}
				} catch {
					// transient poll error — keep trying
				}
			}, 3000);
		} catch (err) {
			setStep("error");
			setError(
				err instanceof Error ? err.message : "Failed to start authentication",
			);
		}
	};

	const handleClose = () => {
		stopPolling();
		setStep("idle");
		setAuthUrl("");
		setUserCode("");
		setError("");
		onClose();
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Re-authenticate Qwen Account</DialogTitle>
					<DialogDescription>
						{account?.name
							? `Re-authenticate "${account.name}". All account metadata (usage stats, priority, settings) will be preserved.`
							: "Re-authenticate Qwen account."}
					</DialogDescription>
				</DialogHeader>

				<div className="py-4">
					{step === "idle" && (
						<p className="text-sm text-muted-foreground">
							Click the button below to start the Qwen device flow. A browser
							window will open for you to authorize.
						</p>
					)}

					{step === "pending" && (
						<div className="space-y-3">
							<p className="text-sm text-muted-foreground">
								Waiting for authorization in browser...
							</p>
							{userCode && (
								<div className="flex items-center gap-2">
									<span className="text-sm text-muted-foreground">
										User code:
									</span>
									<code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
										{userCode}
									</code>
								</div>
							)}
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
						</div>
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
					{(step === "idle" || step === "error") && (
						<Button onClick={handleStart}>Start Re-authentication</Button>
					)}
					<Button variant="outline" onClick={handleClose}>
						{step === "complete" ? "Close" : "Cancel"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
