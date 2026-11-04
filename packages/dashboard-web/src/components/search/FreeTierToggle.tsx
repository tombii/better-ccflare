import { useApiError } from "../../hooks/useApiError";
import { useSetFreeTierEnabled } from "../../hooks/useSearchProviders";

/**
 * The "use free tier" switch: bulk-enables or disables the seeded keyless
 * rows.
 *
 * It lives in its own component so the mutation hook is only mounted when
 * free rows exist — SearchTab itself is also rendered in tests (and by
 * servers that predate seeding) without a query provider.
 */
export function FreeTierToggle({ enabled }: { enabled: boolean }) {
	const mutation = useSetFreeTierEnabled();
	const { formatError } = useApiError();

	return (
		<div className="flex flex-col items-end gap-1">
			<label
				htmlFor="use-free-tier"
				className="flex items-center gap-2 text-sm text-muted-foreground"
			>
				<input
					id="use-free-tier"
					type="checkbox"
					checked={enabled}
					disabled={mutation.isPending}
					onChange={(event) => mutation.mutate(event.target.checked)}
				/>
				Use free tier
			</label>
			{mutation.isError && (
				<p className="text-xs text-destructive">
					Failed to toggle the free tier: {formatError(mutation.error)}
				</p>
			)}
		</div>
	);
}
