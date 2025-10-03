import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Account, RequestPayload, RequestResponse } from "../api";
import { queryKeys } from "../lib/query-keys";

// Connection pool management
const CONNECTION_POOL = new Map<
	string,
	{
		connection: EventSource;
		refCount: number;
		lastUsed: number;
		heartbeat: NodeJS.Timeout;
	}
>();

// Cleanup inactive connections periodically
const CLEANUP_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 60000; // 1 minute
const MAX_RETRIES = 10;
const HEARTBEAT_INTERVAL = 15000; // 15 seconds

// Global cleanup for connection pool
let globalCleanupInterval: Timer | null = null;

const startCleanupInterval = () => {
	if (!globalCleanupInterval) {
		globalCleanupInterval = setInterval(() => {
			const now = Date.now();
			for (const [key, conn] of CONNECTION_POOL.entries()) {
				if (now - conn.lastUsed > CONNECTION_TIMEOUT && conn.refCount === 0) {
					console.log(`Cleaning up inactive SSE connection: ${key}`);
					conn.connection.close();
					clearInterval(conn.heartbeat);
					CONNECTION_POOL.delete(key);
				}
			}
		}, CLEANUP_INTERVAL);
	}
};

const stopCleanupInterval = () => {
	if (globalCleanupInterval) {
		clearInterval(globalCleanupInterval);
		globalCleanupInterval = null;
	}
};

// Start cleanup interval when first connection is created
const getOrCreateCleanupInterval = () => {
	if (!globalCleanupInterval) {
		startCleanupInterval();
	}
	return globalCleanupInterval;
};

export function useRequestStream(limit = 200) {
	const queryClient = useQueryClient();
	const connectionKey = `requests-stream-${limit}`;
	const isMountedRef = useRef(true);

	// Heartbeat to keep connection alive and detect dead connections
	const setupHeartbeat = useCallback((es: EventSource, key: string) => {
		return setInterval(() => {
			if (
				es.readyState === EventSource.CLOSED ||
				es.readyState === EventSource.CONNECTING
			) {
				console.log(`Connection ${key} is not ready, cleaning up`);
				const pooled = CONNECTION_POOL.get(key);
				if (pooled) {
					clearInterval(pooled.heartbeat);
					CONNECTION_POOL.delete(key);
				}
				es.close();
			}
		}, HEARTBEAT_INTERVAL);
	}, []);

	// Reducer for efficient state updates
	type StreamState = {
		requests: RequestPayload[];
		detailsMap: Map<string, RequestResponse>;
	};

	// Limit detailsMap size to prevent unbounded growth
	const MAX_DETAILS_MAP_SIZE = limit * 2;

	type StreamAction =
		| {
				type: "REQUEST_START";
				payload: {
					id: string;
					method: string;
					path: string;
					timestamp: number;
					accountId: string | null;
					statusCode: number;
					agentUsed: string | null;
					accountName?: string;
				};
		  }
		| { type: "REQUEST_PAYLOAD"; payload: RequestPayload }
		| { type: "REQUEST_SUMMARY"; payload: RequestResponse }
		| { type: "SET_ACCOUNTS"; payload: Account[] };

	const streamReducer = (
		state: StreamState,
		action: StreamAction,
	): StreamState => {
		switch (action.type) {
			case "REQUEST_START": {
				const {
					id,
					method,
					path,
					timestamp,
					accountId,
					statusCode,
					agentUsed,
					accountName,
				} = action.payload;

				// Create placeholder
				const placeholder: RequestPayload = {
					id,
					request: { headers: {}, body: null },
					response: { status: statusCode, headers: {}, body: null },
					meta: {
						timestamp,
						path,
						method,
						accountId: accountId || undefined,
						accountName,
						success: false,
						pending: true,
						agentUsed: agentUsed || undefined,
					},
				};

				// Check if exists and update, otherwise add
				const existingIndex = state.requests.findIndex((r) => r.id === id);
				if (existingIndex >= 0) {
					const newRequests = [...state.requests];
					newRequests[existingIndex] = placeholder;
					return { ...state, requests: newRequests };
				}

				// Add to beginning and limit
				return {
					...state,
					requests: [placeholder, ...state.requests].slice(0, limit),
				};
			}

			case "REQUEST_PAYLOAD": {
				const payload = action.payload;
				const newRequests = [...state.requests];
				const idx = newRequests.findIndex((r) => r.id === payload.id);

				if (idx >= 0) {
					newRequests[idx] = payload;
				} else {
					newRequests.unshift(payload);
				}

				return {
					...state,
					requests: newRequests.slice(0, limit),
				};
			}

			case "REQUEST_SUMMARY": {
				const payload = action.payload;
				const map = new Map(state.detailsMap);
				map.set(payload.id, payload);

				// Limit detailsMap size - remove oldest entries
				if (map.size > MAX_DETAILS_MAP_SIZE) {
					const entries = Array.from(map.entries());
					// Remove oldest entries (first entries)
					const toRemove = entries.slice(0, map.size - MAX_DETAILS_MAP_SIZE);
					for (const [id] of toRemove) {
						map.delete(id);
					}
				}

				// Update pending status in requests if it exists
				const requestIndex = state.requests.findIndex(
					(r) => r.id === payload.id,
				);
				if (requestIndex >= 0 && state.requests[requestIndex].meta?.pending) {
					const newRequests = [...state.requests];
					const currentMeta = newRequests[requestIndex].meta || {};
					newRequests[requestIndex] = {
						...newRequests[requestIndex],
						meta: {
							...currentMeta,
							pending: false,
							success: payload.success,
						},
					};
					return { ...state, requests: newRequests, detailsMap: map };
				}

				return { ...state, detailsMap: map };
			}

			case "SET_ACCOUNTS": {
				// Update account names in existing requests
				const accounts = action.payload;
				const accountMap = new Map(accounts.map((a) => [a.id, a.name]));

				const newRequests = state.requests.map((request) => {
					if (request.meta?.accountId && !request.meta.accountName) {
						const accountName = accountMap.get(request.meta.accountId);
						if (accountName) {
							return {
								...request,
								meta: {
									...request.meta,
									accountName,
								},
							};
						}
					}
					return request;
				});

				return { ...state, requests: newRequests };
			}

			default:
				return state;
		}
	};

	// Initialize state
	const [state, dispatch] = useReducer(streamReducer, {
		requests: [],
		detailsMap: new Map(),
	});

	// Sync state with React Query
	useEffect(() => {
		if (!isMountedRef.current) return;
		queryClient.setQueryData(queryKeys.requests(limit), {
			requests: state.requests,
			detailsMap: state.detailsMap,
		});
	}, [state, limit, queryClient]);

	// Sync accounts for account name resolution
	useEffect(() => {
		if (!isMountedRef.current) return;

		const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
			if (
				event.type === "updated" &&
				event.query.queryKey === queryKeys.accounts()
			) {
				const accounts = event.query.state.data as Account[] | undefined;
				if (accounts) {
					dispatch({ type: "SET_ACCOUNTS", payload: accounts });
				}
			}
		});

		// Check initial accounts
		const accounts = queryClient.getQueryData<Account[]>(queryKeys.accounts());
		if (accounts) {
			dispatch({ type: "SET_ACCOUNTS", payload: accounts });
		}

		return () => unsubscribe();
	}, [queryClient]);

	// Memoized account lookup
	const getAccountName = useCallback(
		(accountId: string | null): string | undefined => {
			if (!accountId) return undefined;
			const accounts = queryClient.getQueryData<Account[]>(
				queryKeys.accounts(),
			);
			return accounts?.find((a) => a.id === accountId)?.name;
		},
		[queryClient],
	);

	// Safe message handler with try-catch
	const handleMessage = useCallback(
		(ev: MessageEvent) => {
			if (!isMountedRef.current) return;

			try {
				const evt = JSON.parse(ev.data) as
					| {
							type: "start";
							id: string;
							method: string;
							path: string;
							timestamp: number;
							accountId: string | null;
							statusCode: number;
							agentUsed: string | null;
					  }
					| { type: "summary"; payload: RequestResponse }
					| { type: "payload"; payload: RequestPayload };

				// Get account name for start events
				if (evt.type === "start") {
					dispatch({
						type: "REQUEST_START",
						payload: {
							id: evt.id,
							method: evt.method,
							path: evt.path,
							timestamp: evt.timestamp,
							accountId: evt.accountId,
							statusCode: evt.statusCode,
							agentUsed: evt.agentUsed,
							accountName: getAccountName(evt.accountId),
						},
					});
				} else if (evt.type === "payload") {
					dispatch({ type: "REQUEST_PAYLOAD", payload: evt.payload });
				} else {
					dispatch({ type: "REQUEST_SUMMARY", payload: evt.payload });
				}
			} catch (error) {
				console.error("Error parsing SSE message:", error);
			}
		},
		[getAccountName],
	);

	// Connect with connection pooling
	const connect = useCallback(
		(retryCount = 0): EventSource => {
			// Ensure cleanup interval is running
			getOrCreateCleanupInterval();

			// Check if we have a healthy connection in the pool
			const pooled = CONNECTION_POOL.get(connectionKey);
			if (pooled && pooled.connection.readyState === EventSource.OPEN) {
				pooled.refCount++;
				pooled.lastUsed = Date.now();
				console.log(
					`Reusing pooled SSE connection: ${connectionKey} (refCount: ${pooled.refCount})`,
				);
				return pooled.connection;
			}

			// Close any existing connection for this key
			if (pooled) {
				pooled.connection.close();
				clearInterval(pooled.heartbeat);
				CONNECTION_POOL.delete(connectionKey);
			}

			console.log(`Creating new SSE connection: ${connectionKey}`);
			const es = new EventSource("/api/requests/stream");

			// Setup event handlers
			es.addEventListener("open", () => {
				if (!isMountedRef.current) {
					es.close();
					return;
				}
				console.log(`SSE connection established: ${connectionKey}`);
			});

			es.addEventListener("message", handleMessage);

			es.addEventListener("error", (error) => {
				console.error(`SSE connection error (${connectionKey}):`, error);

				// Remove from pool
				const pooled = CONNECTION_POOL.get(connectionKey);
				if (pooled) {
					clearInterval(pooled.heartbeat);
					CONNECTION_POOL.delete(connectionKey);
				}

				// Only reconnect if component is still mounted and we haven't exceeded max retries
				if (isMountedRef.current && retryCount < MAX_RETRIES) {
					const delay = Math.min(1000 * 2 ** retryCount, 30000);
					console.log(
						`Reconnecting ${connectionKey} in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`,
					);

					setTimeout(() => {
						if (isMountedRef.current) {
							connect(retryCount + 1);
						}
					}, delay);
				} else if (retryCount >= MAX_RETRIES) {
					console.error(`Max retries reached for ${connectionKey}, giving up`);
				}
			});

			// Add to pool with heartbeat
			const heartbeat = setupHeartbeat(es, connectionKey);
			CONNECTION_POOL.set(connectionKey, {
				connection: es,
				refCount: 1,
				lastUsed: Date.now(),
				heartbeat,
			});

			return es;
		},
		[connectionKey, handleMessage, setupHeartbeat],
	);

	useEffect(() => {
		isMountedRef.current = true;
		const es = connect();

		// Cleanup function
		return () => {
			isMountedRef.current = false;

			const pooled = CONNECTION_POOL.get(connectionKey);
			if (pooled) {
				pooled.refCount--;
				pooled.lastUsed = Date.now();

				// Close connection immediately if no more references
				if (pooled.refCount <= 0) {
					console.log(
						`No more references for ${connectionKey}, scheduling cleanup`,
					);
				}
			} else if (es) {
				es.close();
			}
		};
	}, [connect, connectionKey]);

	// Global cleanup on unmount
	useEffect(() => {
		return () => {
			isMountedRef.current = false;

			// Stop global cleanup interval if no more connections
			if (CONNECTION_POOL.size === 0) {
				stopCleanupInterval();
			}
		};
	}, []);
}

// Export global cleanup function for app shutdown
export const cleanupRequestStream = () => {
	// Stop the global cleanup interval
	stopCleanupInterval();

	// Close all pooled connections
	for (const [key, conn] of CONNECTION_POOL.entries()) {
		console.log(`Cleaning up SSE connection on shutdown: ${key}`);
		conn.connection.close();
		clearInterval(conn.heartbeat);
	}
	CONNECTION_POOL.clear();
};
