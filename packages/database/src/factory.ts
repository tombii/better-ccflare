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

export function initialize(
	dbPathParam?: string,
	runtimeConfigParam?: RuntimeConfig,
): void {
	dbPath = dbPathParam;
	runtimeConfig = runtimeConfigParam;
}

export function getInstance(): DatabaseOperations {
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

export function closeAll(): void {
	if (instance) {
		unregisterDisposable(instance);
		instance.close();
		instance = null;
	}
}

export function reset(): void {
	closeAll();
}

export const DatabaseFactory = {
	initialize,
	getInstance,
	closeAll,
	reset,
};
