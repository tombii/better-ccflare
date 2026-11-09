import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "../ui/card";

export interface RoutingInactiveBannerProps {
	routing: {
		combosEnabled: boolean;
		forceAccountModel: boolean;
	};
}

/** Why combo routing is off, for the banner's tooltip. */
export function routingOffReason(routing: {
	combosEnabled: boolean;
	forceAccountModel: boolean;
}): string {
	if (!routing.combosEnabled && routing.forceAccountModel) {
		return "combos are disabled and 'force account model' is on";
	}
	if (!routing.combosEnabled) return "combos are disabled";
	return "'force account model' is on";
}

/**
 * Explains that the chains below are not what the proxy is consulting right
 * now. Without this the page happily draws an enabled assignment while the
 * global combo switch (or "force account model") makes normal pool routing the
 * real path — the exact "disabled routing looks active" confusion.
 *
 * Pure props so the dashboard's static-markup tests can cover it.
 */
export function RoutingInactiveBanner({ routing }: RoutingInactiveBannerProps) {
	return (
		<Card
			className="border-yellow-500/60 bg-yellow-500/5"
			title={`Combo routing is inactive: ${routingOffReason(routing)}`}
		>
			<CardContent className="flex items-start gap-2 p-3 text-xs">
				<AlertTriangle
					className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500"
					aria-hidden="true"
				/>
				<p className="text-muted-foreground">
					<span className="font-medium text-foreground">
						Combo routing is not active right now
					</span>{" "}
					— the proxy is using normal pool routing (combos disabled or “force
					account model” on). The chains below show what WOULD route.
				</p>
			</CardContent>
		</Card>
	);
}
