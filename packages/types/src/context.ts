import type { Config } from "@better-ccflare/config";
import type {
	BunSqlAdapter,
	DatabaseOperations,
} from "@better-ccflare/database";
import type { Account } from "./account";
import type { RequestMeta } from "./api";
import type { ApiKey } from "./api-key";
import type { IntegrityStatus } from "./stats";
import type { StrategyStore } from "./strategy";

// API context for HTTP handlers
export interface APIContext {
	db: BunSqlAdapter;
	config: Config;
	dbOps: DatabaseOperations;
	auth?: {
		isAuthenticated: boolean;
		apiKey?: ApiKey;
	};
	runtime?: {
		port: number;
		tlsEnabled: boolean;
	};
	getAsyncWriterHealth?: () => {
		healthy: boolean;
		failureCount: number;
		recentDrops: number;
		queuedJobs: number;
	};
	getUsageWorkerHealth?: () => {
		state: string;
		pendingAcks: number;
		lastError: string | null;
		startedAt: number | null;
	};
	getIntegrityStatus?: () => IntegrityStatus;
	getStrategy?: () => LoadBalancingStrategy | null;
}

// Load balancing strategy interface
export interface LoadBalancingStrategy {
	/**
	 * Return a filtered & ordered list of candidate accounts.
	 * Accounts that are rate-limited should be filtered out.
	 * The first account in the list should be tried first.
	 */
	select(accounts: Account[], meta: RequestMeta): Account[];

	/**
	 * Side-effect-free preview: return the ID of the account that would
	 * be picked first by select() given the current state, or null if
	 * no account is available. MUST NOT mutate any state (no DB writes,
	 * no resumeAccount, no resetSession, no internal counters).
	 */
	peek(accounts: Account[]): string | null;

	/**
	 * Optional initialization method to inject dependencies
	 * Used for strategies that need access to a StrategyStore
	 */
	initialize?(store: StrategyStore): void;
}
