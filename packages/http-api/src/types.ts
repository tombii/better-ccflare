import type { Database } from "bun:sqlite";
import type { Config } from "@claudeflare/config";
import type { DatabaseOperations } from "@claudeflare/database";

export interface APIContext {
	db: Database;
	config: Config;
	dbOps: DatabaseOperations;
}

export interface HealthResponse {
	status: string;
	accounts: number;
	timestamp: string;
	strategy: string;
}

export interface StatsResponse {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
}

export interface AccountResponse {
	id: string;
	name: string;
	provider: string;
	requestCount: number;
	totalRequests: number;
	lastUsed: string | null;
	created: string;
	tier: number;
	tokenStatus: "valid" | "expired";
	rateLimitStatus: string;
	sessionInfo: string;
}

export interface RequestResponse {
	id: string;
	timestamp: string;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTimeMs: number | null;
	failoverAttempts: number;
}

export interface ConfigResponse {
	lb_strategy: string;
	port: number;
	sessionDurationMs: number;
}

export interface StrategyUpdateRequest {
	strategy: string;
}

export interface TierUpdateRequest {
	tier: number;
}
