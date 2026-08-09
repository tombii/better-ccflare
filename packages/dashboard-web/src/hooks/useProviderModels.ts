import { useMutation, useQuery } from "@tanstack/react-query";
import {
	fetchProviderModels,
	type TestModelResult,
	testAccountModel,
} from "../lib/model-api";
import { queryKeys } from "../lib/query-keys";

/**
 * Provider model list. Disabled while the provider is unknown (no selected
 * account), so the combobox never suggests the wrong provider list.
 */
export const useProviderModels = (
	provider?: string | null,
	accountId?: string | null,
) => {
	const normalized = provider?.trim() ?? "";
	const account = accountId?.trim() ?? "";
	return useQuery({
		queryKey: queryKeys.providerModels(normalized, account),
		queryFn: () => fetchProviderModels(normalized, account),
		enabled: normalized.length > 0,
		staleTime: 5 * 60 * 1000,
		gcTime: 30 * 60 * 1000,
		// The list is a convenience: a failure must not become a retry storm,
		// because the field still accepts free text.
		retry: false,
	});
};

/**
 * Makes ONE real request to the provider. Never call it implicitly: it consumes
 * quota from the tested account.
 */
export const useTestAccountModel = () =>
	useMutation<TestModelResult, Error, { accountId: string; model: string }>({
		mutationFn: ({ accountId, model }) => testAccountModel(accountId, model),
	});
