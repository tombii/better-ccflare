import type {
	ApiKeyResponse,
	ApiKeyUsageResponse,
} from "@better-ccflare/types";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/query-keys";

export function resetSpendConfirmation(name: string): string {
	return `Reset the spend of ${name} against its limits to zero? Its limits stay; usage history is kept. In-flight reservations are cleared; their actual cost counts when recorded after this reset.`;
}

/** Apply the server's fresh limits without replacing any historical statistics. */
export function applyApiKeySpendReset(
	client: QueryClient,
	key: ApiKeyResponse,
) {
	client.setQueryData<ApiKeyResponse[]>(queryKeys.apiKeys(), (keys) =>
		keys?.map((existing) => (existing.id === key.id ? key : existing)),
	);
	client.setQueriesData<ApiKeyUsageResponse>(
		{ queryKey: [...queryKeys.all, "api-key-usage"] },
		(usage) => {
			if (usage?.apiKey.id !== key.id) return usage;
			return {
				...usage,
				apiKey: {
					...usage.apiKey,
					spendResetAt: key.spendResetAt,
					spendResetBy: key.spendResetBy,
				},
				limits: key.limits ?? [],
			};
		},
	);
}
