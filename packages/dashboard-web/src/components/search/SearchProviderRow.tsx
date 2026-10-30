import {
	CircleAlert,
	CircleCheck,
	Loader2,
	Pencil,
	Play,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useApiError } from "../../hooks/useApiError";
import {
	useTestSearchProvider,
	useUpdateSearchProvider,
} from "../../hooks/useSearchProviders";
import type { SearchProviderPublic } from "../../lib/search-provider-types";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { DeleteProviderDialog } from "./DeleteProviderDialog";
import { SearchProviderStatus } from "./SearchProviderStatus";

/**
 * One configured provider: identity, status, masked key, and the inline
 * actions. The raw API key is never available to this component — the list
 * endpoint only ever returns the masked form.
 */
export function SearchProviderRow({
	provider,
	catalogLabel,
	onEdit,
}: {
	provider: SearchProviderPublic;
	catalogLabel?: string;
	onEdit: () => void;
}) {
	const update = useUpdateSearchProvider();
	const test = useTestSearchProvider();
	const { formatError } = useApiError();
	// The draft is the value the user typed; while it equals the last priority
	// we rendered, it simply mirrors the server value, so a reorder returned by
	// the server shows up immediately.
	const [lastPriority, setLastPriority] = useState(provider.priority);
	const [priorityDraft, setPriorityDraft] = useState(String(provider.priority));
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	if (lastPriority !== provider.priority) {
		setLastPriority(provider.priority);
		if (priorityDraft === String(lastPriority)) {
			setPriorityDraft(String(provider.priority));
		}
	}

	const disabled = !provider.enabled;

	const commitPriority = () => {
		const parsed = Number.parseInt(priorityDraft, 10);
		if (!Number.isFinite(parsed) || parsed < 0) {
			setPriorityDraft(String(provider.priority));
			return;
		}
		if (parsed === provider.priority) return;
		update.mutate({ id: provider.id, patch: { priority: parsed } });
	};

	const testResult = test.data;

	return (
		<Card className={cn(disabled && "opacity-60")}>
			<CardContent className="space-y-3 p-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0 flex-1 space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="truncate font-medium">{provider.label}</span>
							<Badge variant="secondary" className="font-mono text-xs">
								{provider.provider}
							</Badge>
							{disabled && (
								<Badge variant="outline" className="text-xs">
									Disabled
								</Badge>
							)}
						</div>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<SearchProviderStatus
								status={provider.status}
								statusMessage={provider.statusMessage}
								cooldownUntil={provider.cooldownUntil}
								testedAt={provider.statusCheckedAt}
							/>
							<span className="text-xs text-muted-foreground">
								Key:{" "}
								<span className="font-mono">
									{provider.apiKeyMasked ?? "none"}
								</span>
							</span>
							{provider.maxResults > 0 && (
								<span className="text-xs text-muted-foreground">
									Max {provider.maxResults} results
								</span>
							)}
						</div>
						{provider.statusMessage && (
							<p className="truncate text-xs text-muted-foreground">
								{provider.statusMessage}
							</p>
						)}
					</div>

					<div className="flex items-center gap-2">
						<Label
							htmlFor={`search-provider-enabled-${provider.id}`}
							className="text-xs text-muted-foreground"
						>
							{provider.enabled ? "Enabled" : "Disabled"}
						</Label>
						<Switch
							id={`search-provider-enabled-${provider.id}`}
							checked={provider.enabled}
							disabled={update.isPending}
							onCheckedChange={(enabled) =>
								update.mutate({ id: provider.id, patch: { enabled } })
							}
						/>
					</div>
				</div>

				<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
					<div className="flex items-center gap-2">
						<Label
							htmlFor={`search-provider-priority-${provider.id}`}
							className="text-xs text-muted-foreground"
						>
							Priority
						</Label>
						<Input
							id={`search-provider-priority-${provider.id}`}
							type="number"
							min={0}
							className="h-8 w-20"
							value={priorityDraft}
							disabled={update.isPending}
							onChange={(e) => setPriorityDraft(e.target.value)}
							onBlur={commitPriority}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitPriority();
							}}
							title="Lower numbers are tried first"
						/>
						<span className="text-xs text-muted-foreground">
							lower = tried first
						</span>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						{testResult && !test.isPending && (
							<span
								className={cn(
									"flex items-center gap-1 text-xs",
									testResult.ok ? "text-green-600" : "text-destructive",
								)}
							>
								{testResult.ok ? (
									<>
										<CircleCheck className="h-3.5 w-3.5" />
										OK · {testResult.latencyMs}ms
									</>
								) : (
									<>
										<CircleAlert className="h-3.5 w-3.5" />
										{testResult.error ?? "Test failed"}
									</>
								)}
							</span>
						)}
						<Button
							variant="outline"
							size="sm"
							onClick={() => test.mutate(provider.id)}
							disabled={test.isPending}
						>
							{test.isPending ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<Play className="h-4 w-4" />
							)}
							Test
						</Button>
						<Button variant="ghost" size="sm" onClick={onEdit} title="Edit">
							<Pencil className="h-4 w-4" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsDeleteOpen(true)}
							className="text-destructive hover:text-destructive"
							title="Delete"
						>
							<Trash2 className="h-4 w-4" />
						</Button>
					</div>
				</div>

				{update.isError && (
					<p className="text-sm text-destructive">
						Could not save the change: {formatError(update.error)}
					</p>
				)}
				{test.isError && (
					<p className="text-sm text-destructive">
						Test request failed: {formatError(test.error)}
					</p>
				)}
			</CardContent>

			{/* Mounted only while open so the typed confirmation and a previous
			    error reset each time. */}
			{isDeleteOpen && (
				<DeleteProviderDialog
					provider={provider}
					catalogLabel={catalogLabel}
					isOpen={isDeleteOpen}
					onClose={() => setIsDeleteOpen(false)}
				/>
			)}
		</Card>
	);
}
