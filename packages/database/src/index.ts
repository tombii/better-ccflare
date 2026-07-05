// Re-export the DatabaseOperations class
import { DatabaseOperations } from "./database-operations";

export type { RuntimeConfig } from "@better-ccflare/config";
export { BunSqlAdapter } from "./adapters/bun-sql-adapter";
export type { AsyncWriterHealth, MetadataWriteResult } from "./async-writer";
// Re-export other utilities
export { AsyncDbWriter } from "./async-writer";
export type {
	DatabaseConfig,
	DatabaseRetryConfig,
} from "./database-operations";
export { DatabaseFactory } from "./factory";
export type { IntegrityCheckKind } from "./integrity-check-runner";
export { runIntegrityCheckInWorker } from "./integrity-check-runner";
export { migrateFromCcflare } from "./migrate-from-ccflare";
export { ensureSchema, runMigrations } from "./migrations";
export { getLegacyDbPath, resolveDbPath } from "./paths";
// Public encryption API — only init/status helpers are exported.
// `encryptPayload`/`decryptPayload` are internal to the database package.
export {
	initPayloadEncryption,
	isEncryptionEnabled,
} from "./payload-encryption";
// Payload storage codec — decode is needed by consumers that read
// `request_payloads.json` directly (payloads are always gzip-encoded on write).
export {
	decodePayloadFromStorage,
	encodePayloadForStorage,
} from "./payload-storage";
export { analyzeIndexUsage } from "./performance-indexes";
export type {
	ModelTranslation,
	SimilarModel,
} from "./repositories/model-translation.repository";
// Re-export repository classes
export { ModelTranslationRepository } from "./repositories/model-translation.repository";
// Re-export repository types
export type { StatsRepository } from "./repositories/stats.repository";
// Re-export retry utilities for external use (from your improvements)
export { withDatabaseRetry, withDatabaseRetrySync } from "./retry";
export { DatabaseOperations };
