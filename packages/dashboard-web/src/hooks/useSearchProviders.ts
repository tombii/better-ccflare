import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/query-keys";
import type {
	CreateSearchProviderInput,
	SearchProviderPublic,
	UpdateSearchProviderInput,
} from "../lib/search-provider-types";
import {
	createSearchProvider,
	deleteSearchProvider,
	getSearchProviderCatalog,
	listSearchProviders,
	reorderSearchProvider,
	testSearchProvider,
	updateSearchProvider,
} from "../lib/search-providers-api";

/** No polling: these change only when someone edits them here. */
const STALE_TIME = 30 * 1000;

export const useSearchProviders = () =>
	useQuery({
		queryKey: queryKeys.searchProviders(),
		queryFn: listSearchProviders,
		staleTime: STALE_TIME,
	});

export const useSearchProviderCatalog = () =>
	useQuery({
		queryKey: queryKeys.searchProviderCatalog(),
		queryFn: getSearchProviderCatalog,
		// The catalog is baked into the server binary; it cannot change while
		// the page is open.
		staleTime: Number.POSITIVE_INFINITY,
	});

/**
 * The server returns the full updated row, so writes go straight into the
 * cache (re-sorted by priority) instead of triggering a refetch. Updates and
 * reorders keep the existing list in place if the cache was never filled.
 */
function useReplaceProviderInCache() {
	const queryClient = useQueryClient();
	return (row: SearchProviderPublic) => {
		queryClient.setQueryData<SearchProviderPublic[]>(
			queryKeys.searchProviders(),
			(prev) => {
				if (!prev) return prev;
				const next = prev.some((p) => p.id === row.id)
					? prev.map((p) => (p.id === row.id ? row : p))
					: [...prev, row];
				return next.sort((a, b) => a.priority - b.priority);
			},
		);
	};
}

export const useCreateSearchProvider = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: CreateSearchProviderInput) =>
			createSearchProvider(input),
		onSuccess: () => {
			// A create can shift priorities of other rows; refetch to be sure.
			queryClient.invalidateQueries({
				queryKey: queryKeys.searchProviders(),
			});
		},
	});
};

export const useUpdateSearchProvider = () => {
	const replace = useReplaceProviderInCache();
	return useMutation({
		mutationFn: ({
			id,
			patch,
		}: {
			id: string;
			patch: UpdateSearchProviderInput;
		}) => updateSearchProvider(id, patch),
		onSuccess: replace,
	});
};

export const useReorderSearchProvider = () => {
	const replace = useReplaceProviderInCache();
	return useMutation({
		mutationFn: ({ id, priority }: { id: string; priority: number }) =>
			reorderSearchProvider(id, priority),
		onSuccess: replace,
	});
};

export const useDeleteSearchProvider = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => deleteSearchProvider(id),
		onMutate: async (id: string) => {
			await queryClient.cancelQueries({
				queryKey: queryKeys.searchProviders(),
			});
			const previous = queryClient.getQueryData<SearchProviderPublic[]>(
				queryKeys.searchProviders(),
			);
			queryClient.setQueryData<SearchProviderPublic[]>(
				queryKeys.searchProviders(),
				(prev) => prev?.filter((p) => p.id !== id),
			);
			return { previous };
		},
		onError: (_error, _id, context) => {
			if (context?.previous) {
				queryClient.setQueryData(queryKeys.searchProviders(), context.previous);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.searchProviders(),
			});
		},
	});
};

/**
 * Runs a provider test. The result (ok / latency / error) is the mutation's
 * `data`; the mutation only rejects on unexpected failures.
 */
export const useTestSearchProvider = () =>
	useMutation({
		mutationFn: (id: string) => testSearchProvider(id),
	});
