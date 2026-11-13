import { useCostTracking } from "../hooks/useCostTracking";

export function CostTrackingNotice({ limits = false }: { limits?: boolean }) {
	const { enabled } = useCostTracking();
	if (enabled) return null;
	return (
		<div
			role="status"
			className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
		>
			<p className="font-semibold">Cost tracking is disabled</p>
			<p>
				{limits
					? "Spend limits are not enforced while cost tracking is disabled. "
					: "Cost figures are hidden while tracking is disabled. "}
				Enabling it resumes tracking for new requests; the gap is not
				backfilled.
			</p>
		</div>
	);
}
