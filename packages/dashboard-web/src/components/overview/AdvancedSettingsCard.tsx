import type { ReactNode } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Separator } from "../ui/separator";
import { ConfigFlagDialog } from "./ConfigFlagDialog";
import { ProviderModelDefaultsDialog } from "./ProviderModelDefaultsDialog";

/**
 * Advanced settings: rarely changed items, each behind its own modal so they
 * do not compete for space with frequently used cards in the SettingsTab
 * grid.
 *
 * To add an item: add an ADVANCED_SETTINGS_ITEMS entry with a title, one
 * description line, and the dialog it opens (already with its own trigger
 * button; see ProviderModelDefaultsDialog). The card itself knows nothing
 * about the content of each item.
 */
interface AdvancedSettingItem {
	id: string;
	title: string;
	description: string;
	dialog: ReactNode;
}

const ADVANCED_SETTINGS_ITEMS: AdvancedSettingItem[] = [
	{
		id: "provider-model-defaults",
		title: "Provider Model Defaults",
		description:
			"Built-in fallback model per provider and Claude family, used only as a last resort.",
		dialog: <ProviderModelDefaultsDialog />,
	},
	{
		id: "combo-session-fallback",
		title: "Combo Session Fallback",
		description:
			"Whether a combo whose slots have all failed may fall through to normal routing.",
		dialog: (
			<ConfigFlagDialog
				title="Combo Session Fallback"
				description="What happens when every slot in a combo has failed."
				path="/api/config/combo-session-fallback"
				switchLabel="Fall through to normal routing when a combo is exhausted"
			>
				<p>
					Off by default: a combo names the accounts that may serve a family, so
					when they have all failed the request stops there. It ends in a 503,
					recorded as <code>combo_session_fallback_disabled</code>, instead of
					being served by an account you did not choose — which is how a request
					meant for one provider ends up on another.
				</p>
				<p>
					Turn it on for the looser behaviour: once every slot has failed, the
					request is retried against the whole account pool.
				</p>
			</ConfigFlagDialog>
		),
	},
];

export function AdvancedSettingsCard() {
	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Advanced</CardTitle>
				<CardDescription>
					Settings you rarely need to touch, each behind its own dialog.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{ADVANCED_SETTINGS_ITEMS.map((item, index) => (
					<div key={item.id}>
						{index > 0 && <Separator className="mb-3" />}
						<div className="flex items-center justify-between gap-3">
							<div className="space-y-0.5">
								<p className="text-sm font-medium">{item.title}</p>
								<p className="text-xs text-muted-foreground">
									{item.description}
								</p>
							</div>
							{item.dialog}
						</div>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
