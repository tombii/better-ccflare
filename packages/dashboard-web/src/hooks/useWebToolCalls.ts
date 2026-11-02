import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../lib/query-keys";
import type { WebToolCallStatus } from "../lib/search-provider-types";
import {
	getWebToolCallSummary,
	listWebToolCalls,
} from "../lib/web-tool-calls-api";

/** How many traces the page shows; the server clamps this to 1..200. */
export const WEB_TOOL_CALLS_LIMIT = 50;
/** The summary strip always covers the last day. */
export const WEB_TOOL_CALL_SUMMARY_HOURS = 24;

/**
 * Newest-first traces. No polling: a search happens only when Claude Code
 * runs one, and the section has its own Refresh button.
 */
export const useWebToolCalls = (status?: WebToolCallStatus) =>
	useQuery({
		queryKey: queryKeys.webToolCalls({ status }),
		queryFn: () => listWebToolCalls({ limit: WEB_TOOL_CALLS_LIMIT, status }),
		// Short enough that a returning tab is fresh without polling.
		staleTime: 15 * 1000,
		// The shared QueryClient polls every 30s by default; a trace list only
		// changes when a search runs, so a button and stale-query refreshes are
		// enough and a background poll would be pure load.
		refetchInterval: false,
	});

export const useWebToolCallSummary = () =>
	useQuery({
		queryKey: queryKeys.webToolCallSummary(WEB_TOOL_CALL_SUMMARY_HOURS),
		queryFn: () => getWebToolCallSummary(WEB_TOOL_CALL_SUMMARY_HOURS),
		staleTime: 15 * 1000,
		refetchInterval: false,
	});
