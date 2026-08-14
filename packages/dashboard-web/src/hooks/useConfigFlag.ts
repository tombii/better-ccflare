import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ConfigFlag,
	fetchConfigFlag,
	saveConfigFlag,
} from "../lib/config-flag-api";
import { queryKeys } from "../lib/query-keys";

/**
 * Reads one on/off config setting. A single small record: short staleTime to
 * avoid duplicate calls between re-renders, and no polling — these change only
 * when someone flips them here.
 */
export const useConfigFlag = (path: string) =>
	useQuery({
		queryKey: queryKeys.configFlag(path),
		queryFn: () => fetchConfigFlag(path),
		staleTime: 30 * 1000,
	});

/**
 * Flips the setting and writes what came back into the cache, rather than
 * refetching: the POST already reports the effective value, which is the only
 * way the UI learns that an env var overrode the write.
 */
export const useSaveConfigFlag = (path: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (enabled: boolean) => saveConfigFlag(path, enabled),
		onSuccess: (flag: ConfigFlag) => {
			queryClient.setQueryData(queryKeys.configFlag(path), flag);
			// The combos switch also decides whether the sidebar shows the tab.
			queryClient.invalidateQueries({ queryKey: queryKeys.features() });
		},
	});
};
