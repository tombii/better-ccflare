import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Disposable } from "@claudeflare/core";
import type { Account, StrategyStore } from "@claudeflare/types";
import { ensureSchema, runMigrations } from "./migrations";
import { resolveDbPath } from "./paths";
import { AccountRepository } from "./repositories/account.repository";
import { OAuthRepository } from "./repositories/oauth.repository";
import {
	type RequestData,
	RequestRepository,
} from "./repositories/request.repository";
import { StrategyRepository } from "./repositories/strategy.repository";

export interface RuntimeConfig {
	sessionDurationMs?: number;
}

/**
 * Refactored DatabaseOperations using Repository Pattern
 * This reduces the file from 452 lines to a much cleaner structure
 */
export class RefactoredDatabaseOperations implements StrategyStore, Disposable {
	private db: Database;
	private runtime?: RuntimeConfig;

	// Repositories
	private accounts: AccountRepository;
	private requests: RequestRepository;
	private oauth: OAuthRepository;
	private strategy: StrategyRepository;

	constructor(dbPath?: string) {
		const resolvedPath = dbPath ?? resolveDbPath();

		// Ensure the directory exists
		const dir = dirname(resolvedPath);
		mkdirSync(dir, { recursive: true });

		this.db = new Database(resolvedPath, { create: true });
		ensureSchema(this.db);
		runMigrations(this.db);

		// Initialize repositories
		this.accounts = new AccountRepository(this.db);
		this.requests = new RequestRepository(this.db);
		this.oauth = new OAuthRepository(this.db);
		this.strategy = new StrategyRepository(this.db);
	}

	setRuntimeConfig(runtime: RuntimeConfig): void {
		this.runtime = runtime;
	}

	getDatabase(): Database {
		return this.db;
	}

	// Account operations delegated to repository
	getAllAccounts(): Account[] {
		return this.accounts.findAll();
	}

	getAccount(accountId: string): Account | null {
		return this.accounts.findById(accountId);
	}

	updateAccountTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
	): void {
		this.accounts.updateTokens(accountId, accessToken, expiresAt, refreshToken);
	}

	updateAccountUsage(accountId: string): void {
		const sessionDuration =
			this.runtime?.sessionDurationMs || 5 * 60 * 60 * 1000;
		this.accounts.incrementUsage(accountId, sessionDuration);
	}

	markAccountRateLimited(accountId: string, until: number): void {
		this.accounts.setRateLimited(accountId, until);
	}

	updateAccountRateLimitMeta(
		accountId: string,
		status: string,
		reset: number | null,
		remaining?: number | null,
	): void {
		this.accounts.updateRateLimitMeta(accountId, status, reset, remaining);
	}

	updateAccountTier(accountId: string, tier: number): void {
		this.accounts.updateTier(accountId, tier);
	}

	pauseAccount(accountId: string): void {
		this.accounts.pause(accountId);
	}

	resumeAccount(accountId: string): void {
		this.accounts.resume(accountId);
	}

	resetAccountSession(accountId: string, timestamp: number): void {
		this.accounts.resetSession(accountId, timestamp);
	}

	updateAccountRequestCount(accountId: string, count: number): void {
		this.accounts.updateRequestCount(accountId, count);
	}

	// Request operations delegated to repository
	saveRequestMeta(
		id: string,
		method: string,
		path: string,
		accountUsed: string | null,
		statusCode: number | null,
		timestamp?: number,
	): void {
		this.requests.saveMeta(
			id,
			method,
			path,
			accountUsed,
			statusCode,
			timestamp,
		);
	}

	saveRequest(
		id: string,
		method: string,
		path: string,
		accountUsed: string | null,
		statusCode: number | null,
		success: boolean,
		errorMessage: string | null,
		responseTime: number,
		failoverAttempts: number,
		usage?: RequestData["usage"],
	): void {
		this.requests.save({
			id,
			method,
			path,
			accountUsed,
			statusCode,
			success,
			errorMessage,
			responseTime,
			failoverAttempts,
			usage,
		});
	}

	updateRequestUsage(requestId: string, usage: RequestData["usage"]): void {
		this.requests.updateUsage(requestId, usage);
	}

	saveRequestPayload(id: string, data: unknown): void {
		this.requests.savePayload(id, data);
	}

	getRequestPayload(id: string): unknown | null {
		return this.requests.getPayload(id);
	}

	listRequestPayloads(limit = 50): Array<{ id: string; json: string }> {
		return this.requests.listPayloads(limit);
	}

	listRequestPayloadsWithAccountNames(
		limit = 50,
	): Array<{ id: string; json: string; account_name: string | null }> {
		return this.requests.listPayloadsWithAccountNames(limit);
	}

	// OAuth operations delegated to repository
	createOAuthSession(
		sessionId: string,
		accountName: string,
		verifier: string,
		mode: "console" | "max",
		tier: number,
		ttlMinutes = 10,
	): void {
		this.oauth.createSession(
			sessionId,
			accountName,
			verifier,
			mode,
			tier,
			ttlMinutes,
		);
	}

	getOAuthSession(sessionId: string): {
		accountName: string;
		verifier: string;
		mode: "console" | "max";
		tier: number;
	} | null {
		return this.oauth.getSession(sessionId);
	}

	deleteOAuthSession(sessionId: string): void {
		this.oauth.deleteSession(sessionId);
	}

	cleanupExpiredOAuthSessions(): number {
		return this.oauth.cleanupExpiredSessions();
	}

	// Strategy operations delegated to repository
	getStrategy(name: string): {
		name: string;
		config: Record<string, unknown>;
		updatedAt: number;
	} | null {
		return this.strategy.getStrategy(name);
	}

	setStrategy(name: string, config: Record<string, unknown>): void {
		this.strategy.set(name, config);
	}

	listStrategies(): Array<{
		name: string;
		config: Record<string, unknown>;
		updatedAt: number;
	}> {
		return this.strategy.list();
	}

	deleteStrategy(name: string): boolean {
		return this.strategy.delete(name);
	}

	// Analytics methods delegated to request repository
	getRecentRequests(limit = 100): Array<{
		id: string;
		timestamp: number;
		method: string;
		path: string;
		account_used: string | null;
		status_code: number | null;
		success: boolean;
		response_time_ms: number | null;
	}> {
		return this.requests.getRecentRequests(limit);
	}

	getRequestStats(since?: number): {
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		avgResponseTime: number | null;
	} {
		return this.requests.getRequestStats(since);
	}

	aggregateStats(rangeMs?: number) {
		return this.requests.aggregateStats(rangeMs);
	}

	getRecentErrors(limit?: number): string[] {
		return this.requests.getRecentErrors(limit);
	}

	getTopModels(limit?: number): Array<{ model: string; count: number }> {
		return this.requests.getTopModels(limit);
	}

	getRequestsByAccount(since?: number): Array<{
		accountId: string;
		accountName: string | null;
		requestCount: number;
		successRate: number;
	}> {
		return this.requests.getRequestsByAccount(since);
	}

	close(): void {
		this.db.close();
	}

	dispose(): void {
		this.close();
	}
}
