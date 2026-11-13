import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchConfigFlag, saveConfigFlag } from "../lib/config-flag-api";

export const COST_TRACKING_QUERY_KEY = ["cost-tracking"] as const;
const PATH = "/api/config/cost-tracking";

/** Shared by settings and every cost display, including API-only usage. */
export function useCostTracking() {
	const query = useQuery({
		queryKey: COST_TRACKING_QUERY_KEY,
		queryFn: () => fetchConfigFlag(PATH),
		staleTime: 15_000,
		refetchInterval: 30_000,
	});
	return { ...query, enabled: query.data?.enabled ?? true };
}

export function useSetCostTracking() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (enabled: boolean) => saveConfigFlag(PATH, enabled),
		onSuccess: (flag) => {
			client.setQueryData(COST_TRACKING_QUERY_KEY, flag);
		},
	});
}
