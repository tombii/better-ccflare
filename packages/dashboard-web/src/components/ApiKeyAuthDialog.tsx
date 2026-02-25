import { AlertCircle, Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ApiKeyAuthDialogProps {
	isOpen: boolean;
	onAuthenticate: (apiKey: string) => Promise<boolean>;
	error?: string | null;
}

export function ApiKeyAuthDialog({
	isOpen,
	onAuthenticate,
	error: externalError,
}: ApiKeyAuthDialogProps) {
	const [apiKey, setApiKey] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setIsLoading(true);

		try {
			const success = await onAuthenticate(apiKey);
			if (!success) {
				// Error is already set by the parent component
				// No need to set a generic message here
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to authenticate");
		} finally {
			setIsLoading(false);
		}
	};

	const displayError = externalError || error;

	return (
		<Dialog open={isOpen} onOpenChange={() => {}}>
			<DialogContent
				className="sm:max-w-md"
				onEscapeKeyDown={(e) => e.preventDefault()}
				onPointerDownOutside={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
			>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<div className="flex items-center gap-2">
							<Lock className="h-5 w-5 text-primary" />
							<DialogTitle>Authentication Required</DialogTitle>
						</div>
						<DialogDescription>
							An API key has been configured for this server. Please enter your
							API key to access the dashboard.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 py-4">
						{displayError && (
							<div className="rounded-md border border-destructive bg-destructive/10 p-3">
								<div className="flex items-center gap-2">
									<AlertCircle className="h-4 w-4 text-destructive" />
									<p className="text-sm text-destructive">{displayError}</p>
								</div>
							</div>
						)}

						<div className="space-y-2">
							<Label htmlFor="api-key">API Key</Label>
							<Input
								id="api-key"
								type="password"
								placeholder="btr-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								disabled={isLoading}
								autoFocus
								autoComplete="off"
								className="font-mono"
							/>
							<p className="text-xs text-muted-foreground">
								Enter your better-ccflare API key (starts with "btr-")
							</p>
						</div>
					</div>

					<DialogFooter>
						<Button type="submit" disabled={!apiKey || isLoading}>
							{isLoading ? "Authenticating..." : "Authenticate"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
