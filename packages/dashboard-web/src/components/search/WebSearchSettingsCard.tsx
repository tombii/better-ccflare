import { useEffect, useState } from "react";
import { useApiError } from "../../hooks/useApiError";
import {
	useSaveWebSearchSettings,
	useWebSearchSettings,
} from "../../hooks/useWebSearchSettings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/**
 * The master switch for web-search interception plus its two numeric/boolean
 * companions.
 *
 * The switch saves immediately (like every other toggle in the dashboard);
 * `maxResultChars` is a number input, so it saves only on Apply — a save per
 * keystroke would write partial numbers.
 */
export function WebSearchSettingsCard() {
	const settingsQuery = useWebSearchSettings();
	const save = useSaveWebSearchSettings();
	const { formatError } = useApiError();

	const enabled = settingsQuery.data?.enabled ?? false;
	const bypassHeader = settingsQuery.data?.bypassHeader ?? false;
	const savedMax = settingsQuery.data?.maxResultChars;
	const [maxDraft, setMaxDraft] = useState("");
	const [validationError, setValidationError] = useState<string | null>(null);

	// Resync the draft whenever the server value arrives or changes (initial
	// load, or after a successful save echoes the new value back).
	useEffect(() => {
		if (savedMax !== undefined) setMaxDraft(String(savedMax));
	}, [savedMax]);

	// Apply is disabled while a save is in flight, so the resync above can
	// safely overwrite the draft once the server has confirmed the new value.
	const maxDirty = savedMax !== undefined && maxDraft !== String(savedMax);
	const busy = settingsQuery.isLoading || save.isPending;

	const handleApplyMax = () => {
		const parsed = Number.parseInt(maxDraft, 10);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			setValidationError("Enter a positive whole number of characters.");
			return;
		}
		setValidationError(null);
		save.mutate({ maxResultChars: parsed });
	};

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Web search</CardTitle>
				<CardDescription>
					Handle requests from clients that would search the web, using the
					providers listed below instead of passing them upstream.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<div className="flex items-center justify-between gap-4 rounded-md border p-3">
					<div className="space-y-0.5">
						<Label htmlFor="web-search-enabled" className="text-sm font-medium">
							Intercept web_search
						</Label>
						<p className="text-xs text-muted-foreground">
							When off, search requests pass through to the upstream provider
							untouched.
						</p>
					</div>
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"text-xs",
								enabled ? "text-foreground" : "text-muted-foreground",
							)}
						>
							{enabled ? "On" : "Off"}
						</span>
						<Switch
							id="web-search-enabled"
							checked={enabled}
							disabled={busy}
							onCheckedChange={(next) => save.mutate({ enabled: next })}
						/>
					</div>
				</div>

				<div className="flex items-end justify-between gap-4 rounded-md border p-3">
					<div className="space-y-0.5">
						<Label
							htmlFor="web-search-max-chars"
							className="text-sm font-medium"
						>
							Max characters per result
						</Label>
						<p className="text-xs text-muted-foreground">
							Search snippets are truncated to this length before they are sent
							to the model.
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Input
							id="web-search-max-chars"
							type="number"
							min={1}
							className="w-28"
							value={maxDraft}
							disabled={busy}
							onChange={(e) => setMaxDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && maxDirty) handleApplyMax();
							}}
						/>
						<Button
							size="sm"
							variant="outline"
							onClick={handleApplyMax}
							disabled={busy || !maxDirty}
						>
							Apply
						</Button>
					</div>
				</div>

				<div className="flex items-center justify-between gap-4 rounded-md border p-3">
					<div className="space-y-0.5">
						<Label
							htmlFor="web-search-bypass-header"
							className="text-sm font-medium"
						>
							Per-request bypass header
						</Label>
						<p className="text-xs text-muted-foreground">
							Allow a client to skip interception for one request by sending the
							bypass header. When off, the header is ignored.
						</p>
					</div>
					<Switch
						id="web-search-bypass-header"
						checked={bypassHeader}
						disabled={busy}
						onCheckedChange={(next) => save.mutate({ bypassHeader: next })}
					/>
				</div>

				{settingsQuery.isError && (
					<p className="text-sm text-destructive">
						{formatError(settingsQuery.error)} Tried to load web-search settings
						— they may not be available on this server version.
					</p>
				)}
				{validationError && (
					<p className="text-sm text-destructive">{validationError}</p>
				)}
				{save.isError && (
					<p className="text-sm text-destructive">
						Could not save the setting: {formatError(save.error)}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
