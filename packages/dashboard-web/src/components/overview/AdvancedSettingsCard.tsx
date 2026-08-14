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
	{
		id: "force-account-model",
		title: "Force Account Model",
		description:
			"Send the model that was asked for, or nothing — no combo, no mapping, no substitute.",
		dialog: (
			<ConfigFlagDialog
				title="Force Account Model"
				description="Whether the model a client asks for must be the model that is sent."
				path="/api/config/force-account-model"
				switchLabel="Only serve the requested model"
			>
				<p>
					On, nothing renames a request on its way out. Account selection keeps
					only accounts that can serve the model as written, and a request with
					no such account gets a 503 (
					<code>force_account_model_no_account</code>) instead of a different
					model. Switching account to serve the same model is still fine.
				</p>
				<p className="font-medium text-foreground">
					It turns off three things you may be relying on:
				</p>
				<ul className="ml-4 list-disc space-y-0.5">
					<li>combos — no slot model is applied</li>
					<li>
						account model mappings, the global provider defaults, and the
						built-in map
					</li>
					<li>
						the meaning of a Claude family name: asking for a Claude model now
						reaches only accounts that speak Claude ids, so name the model you
						actually want (for example the provider's own model id) in your
						client
					</li>
				</ul>
				<p>
					Accounts that have listed their own models are checked against that
					list. For the rest — nothing is persisted, so listings start empty
					after each restart — the account's provider decides, which is coarse:
					with several non-Claude providers configured a request can still reach
					the wrong one. That surfaces as an upstream error, never as a silent
					substitution.
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
