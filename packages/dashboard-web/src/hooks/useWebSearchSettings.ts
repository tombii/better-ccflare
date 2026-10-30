import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/query-keys";
import type { WebSearchSettings } from "../lib/search-provider-types";
import {
	fetchWebSearchSettings,
	saveWebSearchSettings,
} from "../lib/web-search-api";

/**
 * Reads the master web-search settings. No polling — they change only when
 * someone edits them here.
 */
export const useWebSearchSettings = () =>
	useQuery({
		queryKey: queryKeys.webSearchSettings(),
		queryFn: fetchWebSearchSettings,
		staleTime: 30 * 1000,
	});

/** Writes a subset of the settings and caches what the server confirmed. */
export const useSaveWebSearchSettings = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: Partial<WebSearchSettings>) =>
			saveWebSearchSettings(patch),
		onSuccess: (settings: WebSearchSettings) => {
			queryClient.setQueryData(queryKeys.webSearchSettings(), settings);
		},
	});
};
