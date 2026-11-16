import type { ApiKeyRestrictions } from "@better-ccflare/types";
import { Shield, ShieldAlert, ShieldOff } from "lucide-react";
import { Badge } from "../ui/badge";
import { summarizeRestrictions } from "./restrictions";

export interface ApiKeyRestrictionsSummaryProps {
	restrictions: ApiKeyRestrictions;
	/** account id -> account name, for resolving allowedAccounts. */
	accountNames: Map<string, string>;
}

/** Terse restriction badge for a key row; the full lists live in the tooltip. */
export function ApiKeyRestrictionsSummary({
	restrictions,
	accountNames,
}: ApiKeyRestrictionsSummaryProps) {
	const summary = summarizeRestrictions(restrictions, accountNames);
	const Icon = summary.deniesAll
		? ShieldAlert
		: summary.restricted
			? Shield
			: ShieldOff;

	return (
		<Badge
			variant={
				summary.deniesAll
					? "destructive"
					: summary.restricted
						? "secondary"
						: "outline"
			}
			className="gap-1 px-2 py-0 text-[11px] font-normal"
			title={summary.detail}
		>
			<Icon className="h-3 w-3 shrink-0" />
			{summary.text}
		</Badge>
	);
}
