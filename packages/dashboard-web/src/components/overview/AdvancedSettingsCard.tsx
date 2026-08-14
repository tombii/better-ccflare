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
				envVar="CCFLARE_DISABLE_COMBO_SESSION_FALLBACK"
			>
				<p>
					On (the default) is the historical behaviour: once every slot in the
					combo has failed, the request is retried against the whole account
					pool.
				</p>
				<p>
					Turn it off to keep combo chains isolated. That is what you want when
					combos deliberately separate provider pools — an Anthropic-only Opus
					combo next to a Codex-only Sonnet one — because a fallthrough would
					serve the request from the wrong pool. Requests then end in a 503
					instead, recorded as <code>combo_session_fallback_disabled</code>.
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
