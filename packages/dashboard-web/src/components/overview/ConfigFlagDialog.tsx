import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useConfigFlag, useSaveConfigFlag } from "../../hooks/useConfigFlag";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/**
 * One on/off setting behind its own dialog, for the Advanced card.
 *
 * Shared rather than copied per setting: each of these is a switch, a sentence
 * saying what turning it on costs, and nothing else. These settings are read
 * from the config file only — no environment variable can override them —
 * precisely so this control never has to be drawn disabled with an apology.
 */
export function ConfigFlagDialog({
	title,
	description,
	path,
	switchLabel,
	children,
	triggerLabel = "Configure",
}: {
	title: string;
	description: string;
	/** Endpoint serving { enabled, source } and accepting { enabled }. */
	path: string;
	/** Label next to the switch, phrased by what being on allows. */
	switchLabel: string;
	/** Explanation shown under the switch. */
	children: ReactNode;
	triggerLabel?: string;
}) {
	const flagQuery = useConfigFlag(path);
	const saveFlag = useSaveConfigFlag(path);

	const enabled = flagQuery.data?.enabled ?? false;
	const busy = flagQuery.isLoading || saveFlag.isPending;
	const switchId = `config-flag-${path.replace(/[^a-z0-9]+/gi, "-")}`;

	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					{triggerLabel}
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div className="flex items-center justify-between gap-4 rounded-md border p-3">
					<Label htmlFor={switchId} className="text-sm font-normal">
						{switchLabel}
					</Label>
					<div className="flex items-center gap-2">
						{busy && (
							<Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
						)}
						<Switch
							id={switchId}
							checked={enabled}
							disabled={busy}
							onCheckedChange={(next) => saveFlag.mutate(next)}
						/>
					</div>
				</div>

				<div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
					{children}
					{saveFlag.isError && (
						<p className="text-destructive">
							Could not save the setting. Try again.
						</p>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
