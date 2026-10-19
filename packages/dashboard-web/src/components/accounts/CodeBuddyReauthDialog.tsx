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

interface CodeBuddyReauthDialogProps {
	account: Account | null;
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

type Step = "idle" | "pending" | "complete" | "error";

export function CodeBuddyReauthDialog({
	account,
	isOpen,
	onClose,
	onSuccess,
}: CodeBuddyReauthDialogProps) {
	const [step, setStep] = useState<Step>("idle");
	const [authUrl, setAuthUrl] = useState("");
	const [error, setError] = useState("");
	const sessionIdRef = useRef<string>("");
	const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// Bumped on close/unmount so a late `initCodeBuddyReauth` result cannot
	// open a tab or start polling after the dialog is gone.
	const attemptRef = useRef(0);

	const stopPolling = useCallback(() => {
		if (pollIntervalRef.current !== null) {
			clearInterval(pollIntervalRef.current);
			pollIntervalRef.current = null;
		}
	}, []);

	// Clean up on unmount or close
	useEffect(() => {
		if (!isOpen) {
			attemptRef.current += 1;
			stopPolling();
		}
		return () => {
			attemptRef.current += 1;
			stopPolling();
		};
	}, [isOpen, stopPolling]);

	const handleStart = async () => {
		if (!account) return;
		const attempt = ++attemptRef.current;
		setStep("pending");
		setError("");

		try {
			const result = await api.initCodeBuddyReauth({ accountId: account.id });
			if (attemptRef.current !== attempt) return;
			sessionIdRef.current = result.sessionId;
			setAuthUrl(result.authUrl);

			window.open(result.authUrl, "_blank");

			pollIntervalRef.current = setInterval(async () => {
				try {
					const status = await api.getCodeBuddyAuthStatus(sessionIdRef.current);
					if (attemptRef.current !== attempt) return;
					if (status.status === "complete") {
						stopPolling();
						setStep("complete");
						setTimeout(() => {
							if (attemptRef.current !== attempt) return;
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
			if (attemptRef.current !== attempt) return;
			setStep("error");
			setError(
				err instanceof Error ? err.message : "Failed to start authentication",
			);
		}
	};

	const handleClose = () => {
		attemptRef.current += 1;
		stopPolling();
		setStep("idle");
		setAuthUrl("");
		setError("");
		onClose();
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Re-authenticate CodeBuddy Account</DialogTitle>
					<DialogDescription>
						{account?.name
							? `Re-authenticate "${account.name}". All account metadata (usage stats, priority, settings) will be preserved.`
							: "Re-authenticate CodeBuddy account."}
					</DialogDescription>
				</DialogHeader>

				<div className="py-4">
					{step === "idle" && (
						<p className="text-sm text-muted-foreground">
							Click the button below to start CodeBuddy authentication. A
							browser window will open for you to sign in.
						</p>
					)}

					{step === "pending" && (
						<div className="space-y-3">
							<p className="text-sm text-muted-foreground">
								Waiting for authorization in browser...
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
