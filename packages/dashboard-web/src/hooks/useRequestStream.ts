import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
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

	// Safe message handler with try-catch that directly updates React Query cache
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

				queryClient.setQueryData(
					queryKeys.requests(limit),
					(
						current:
							| {
									requests: RequestPayload[];
									detailsMap: Map<string, RequestResponse> | RequestResponse[];
							  }
							| undefined,
					) => {
						if (!current) return current;

						// Ensure detailsMap is a Map
						const currentDetailsMap =
							current.detailsMap instanceof Map
								? current.detailsMap
								: new Map(
										(current.detailsMap as RequestResponse[]).map((s) => [
											s.id,
											s,
										]),
									);

						if (evt.type === "start") {
							// Look up account name from cache
							const accounts = queryClient.getQueryData<Account[]>(
								queryKeys.accounts(),
							);
							const account = accounts?.find((a) => a.id === evt.accountId);

							// Create a lightweight placeholder payload
							const placeholder: RequestPayload = {
								id: evt.id,
								request: { headers: {}, body: null },
								response: {
									status: evt.statusCode,
									headers: {},
									body: null,
								},
								meta: {
									timestamp: evt.timestamp,
									path: evt.path,
									method: evt.method,
									accountId: evt.accountId || undefined,
									accountName: account?.name,
									success: false,
									pending: true,
									agentUsed: evt.agentUsed || undefined,
								},
							};

							// Check if this request already exists
							const existingIndex = current.requests.findIndex(
								(r) => r.id === evt.id,
							);
							if (existingIndex >= 0) {
								// Update existing placeholder
								const newRequests = [...current.requests];
								newRequests[existingIndex] = placeholder;
								return {
									...current,
									requests: newRequests,
									detailsMap: currentDetailsMap,
								};
							}

							// Add new placeholder at the beginning
							return {
								...current,
								requests: [placeholder, ...current.requests].slice(0, limit),
								detailsMap: currentDetailsMap,
							};
						}
						if (evt.type === "payload") {
							// Replace placeholder or insert if missing
							const newRequests = [...current.requests];
							const idx = newRequests.findIndex((r) => r.id === evt.payload.id);
							if (idx >= 0) {
								newRequests[idx] = evt.payload;
							} else {
								newRequests.unshift(evt.payload);
							}
							return {
								...current,
								requests: newRequests.slice(0, limit),
								detailsMap: currentDetailsMap,
							};
						}
						// Update details map with summary
						const map = new Map(currentDetailsMap);
						map.set(evt.payload.id, evt.payload);

						// Update the request if it exists
						const requestIndex = current.requests.findIndex(
							(r) => r.id === evt.payload.id,
						);
						if (requestIndex >= 0) {
							const newRequests = [...current.requests];
							// Update meta to remove pending status
							if (newRequests[requestIndex].meta) {
								newRequests[requestIndex] = {
									...newRequests[requestIndex],
									meta: {
										...newRequests[requestIndex].meta,
										pending: false,
										success: evt.payload.success,
									},
								};
							}
							return { ...current, requests: newRequests, detailsMap: map };
						}

						return { ...current, detailsMap: map };
					},
				);
			} catch (error) {
				console.error("Error parsing SSE message:", error);
			}
		},
		[queryClient, limit],
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
