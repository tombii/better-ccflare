import { useConfigFlag, useSaveConfigFlag } from "../../hooks/useConfigFlag";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { HelpPopover } from "../ui/help-popover";
import { Switch } from "../ui/switch";

export const COMBOS_ENABLED_PATH = "/api/config/combos-enabled";

/**
 * Explains what a combo is and carries the routing switch. The tab remains
 * visible while this is off so the operator can always turn combos back on.
 */
export function CombosIntroCard() {
	const flagQuery = useConfigFlag(COMBOS_ENABLED_PATH);
	const saveFlag = useSaveConfigFlag(COMBOS_ENABLED_PATH);

	const enabled = flagQuery.data?.enabled ?? false;
	const busy = flagQuery.isLoading || saveFlag.isPending;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1.5">
						<CardTitle className="flex items-center gap-2">
							Combos
							<HelpPopover label="How a combo decides which account and model to use">
								<p>
									A combo is a list of accounts, in order, tied to one Claude
									model family. A request for that family is served by the
									accounts in the combo instead of the whole pool.
								</p>
								<p>
									Each slot may also carry a model, which is then sent upstream
									in place of the model the client asked for. Leave the slot's
									model empty to forward the client's own model unchanged.
								</p>
								<p className="font-medium text-foreground">
									Which model is sent, first match wins:
								</p>
								<ol className="ml-4 list-decimal space-y-0.5">
									<li>the combo slot's model</li>
									<li>the account's own model mapping</li>
									<li>
										the provider default you set under Settings → Advanced
									</li>
									<li>the provider's built-in default</li>
								</ol>
								<p>
									Turning combos off here leaves them configured but inert:
									every request goes back to normal pool routing.
								</p>
							</HelpPopover>
						</CardTitle>
						<CardDescription>
							Route a model family to a chosen set of accounts, in a chosen
							order.
						</CardDescription>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<span className="text-sm text-muted-foreground">
							{enabled ? "On" : "Off"}
						</span>
						<Switch
							checked={enabled}
							disabled={busy}
							onCheckedChange={(next) => saveFlag.mutate(next)}
							aria-label="Use combos for routing"
						/>
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-2 text-sm text-muted-foreground">
				{!enabled && (
					<p>
						Combos are off: the combos below are saved but do not affect
						routing.
					</p>
				)}
				{saveFlag.isError && (
					<p className="text-destructive">
						Could not save the setting. Try again.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
