import type { RuntimeConfig } from "@better-ccflare/config";
import { registerDisposable, unregisterDisposable } from "@better-ccflare/core";
import {
	type DatabaseConfig,
	DatabaseOperations,
	type DatabaseRetryConfig,
} from "./database-operations";
import { migrateFromCcflare } from "./migrate-from-ccflare";

let instance: DatabaseOperations | null = null;
let dbPath: string | undefined;
let runtimeConfig: RuntimeConfig | undefined;
let migrationChecked = false;

/**
 * The `fastMode` parameter is retained for backward compatibility with
 * callers (CLI commands, tests) that still pass it. It is now a no-op:
 * startup no longer runs `PRAGMA integrity_check`, so there's nothing
 * left to skip. Integrity is verified by the background scheduler — see
 * `packages/proxy/src/integrity-scheduler.ts`.
 */
export function initialize(
	dbPathParam?: string,
	runtimeConfigParam?: RuntimeConfig,
	_fastMode = false,
): void {
	dbPath = dbPathParam;
	runtimeConfig = runtimeConfigParam;
}

export function getInstance(_fastMode?: boolean): DatabaseOperations {
	if (!instance) {
		// Perform one-time migration check from legacy ccflare
		if (!migrationChecked) {
			migrateFromCcflare();
			migrationChecked = true;
		}
		// Extract database configuration from runtime config
		const dbConfig: DatabaseConfig | undefined = runtimeConfig?.database
			? {
					...(runtimeConfig.database.walMode !== undefined && {
						walMode: runtimeConfig.database.walMode,
					}),
					...(runtimeConfig.database.busyTimeoutMs !== undefined && {
						busyTimeoutMs: runtimeConfig.database.busyTimeoutMs,
					}),
					...(runtimeConfig.database.cacheSize !== undefined && {
						cacheSize: runtimeConfig.database.cacheSize,
					}),
					...(runtimeConfig.database.synchronous !== undefined && {
						synchronous: runtimeConfig.database.synchronous,
					}),
					...(runtimeConfig.database.mmapSize !== undefined && {
						mmapSize: runtimeConfig.database.mmapSize,
					}),
					...(runtimeConfig.database.pageSize !== undefined && {
						pageSize: runtimeConfig.database.pageSize,
					}),
				}
			: undefined;

		const retryConfig: DatabaseRetryConfig | undefined =
			runtimeConfig?.database?.retry;

		instance = new DatabaseOperations(dbPath, dbConfig, retryConfig);
		if (runtimeConfig) {
			instance.setRuntimeConfig(runtimeConfig);
		}
		// Register with lifecycle manager
		registerDisposable(instance);
	}
	return instance;
}

/**
 * Get or create the database instance, running async initialization for PostgreSQL.
 * Use this in server startup code where async is available.
 */
export async function getInstanceAsync(
	_fastMode?: boolean,
): Promise<DatabaseOperations> {
	const db = getInstance();
	// Initialize PostgreSQL schema/migrations if needed
	await db.initializeAsync();
	return db;
}

export function closeAll(): void {
	if (instance) {
		unregisterDisposable(instance);
		// Fire-and-forget close (sync-compatible)
		void instance.close();
		instance = null;
	}
}

export function reset(): void {
	closeAll();
}

export const DatabaseFactory = {
	initialize,
	getInstance,
	getInstanceAsync,
	closeAll,
	reset,
};
