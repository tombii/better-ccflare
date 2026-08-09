import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fetchProviderModelDefaults,
	type ProviderModelDefaultOverrideInput,
	saveProviderModelDefaultOverrides,
} from "../lib/provider-model-defaults-api";
import { queryKeys } from "../lib/query-keys";

/**
 * Per-provider-and-family default model map (the one embedded in code, the
 * last word in the resolution chain). Few records: short staleTime only to
 * avoid duplicate calls between re-renders, with no polling.
 */
export const useProviderModelDefaults = () =>
	useQuery({
		queryKey: queryKeys.providerModelDefaults(),
		queryFn: fetchProviderModelDefaults,
		staleTime: 30 * 1000,
	});

/**
 * Saves the overrides edited on screen in one operation. Invalidates the query
 * above to reload the effective value after saving.
 */
export const useSaveProviderModelDefaults = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (overrides: ProviderModelDefaultOverrideInput[]) =>
			saveProviderModelDefaultOverrides(overrides),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.providerModelDefaults(),
			});
		},
	});
};
