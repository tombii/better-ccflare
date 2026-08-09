import type { ReactNode } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Separator } from "../ui/separator";
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
