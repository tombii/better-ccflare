#!/usr/bin/env bun

// Test script to debug usage polling issue
import { usageCache, fetchUsageData } from "./packages/providers/src/usage-fetcher.ts";
import { getValidAccessToken } from "./packages/proxy/src/handlers/token-manager.ts";
import { createProxyContext } from "./packages/proxy/src/proxy.ts";
import { DatabaseFactory } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("DebugUsage");

async function debugUsageIssue() {
  log.info("Starting usage polling debug...");

  try {
    // Test 1: Check if usageCache works
    log.info("Test 1: Checking usage cache...");
    const testAccountId = "test-account";
    usageCache.set(testAccountId, {
      five_hour: { utilization: 50, resets_at: new Date().toISOString() },
      seven_day: { utilization: 30, resets_at: new Date().toISOString() },
      seven_day_oauth_apps: { utilization: 0, resets_at: null },
      seven_day_opus: { utilization: 0, resets_at: null }
    });

    const cached = usageCache.get(testAccountId);
    log.info(`Usage cache test: ${cached ? "PASS" : "FAIL"}`);

    // Test 2: Try to create database context
    log.info("Test 2: Creating database context...");
    const db = new DatabaseFactory().createDatabase();
    const dbOps = new DatabaseOperations(db);

    // Test 3: Load Anthropic accounts
    log.info("Test 3: Loading Anthropic accounts...");
    const accounts = dbOps.getAllAccounts();
    const anthropicAccounts = accounts.filter((a) => a.provider === "anthropic");
    log.info(`Found ${anthropicAccounts.length} Anthropic accounts`);

    if (anthropicAccounts.length > 0) {
      const account = anthropicAccounts[0];
      log.info(`Testing with account: ${account.name}`);

      // Test 4: Try to get valid access token
      log.info("Test 4: Testing access token...");
      try {
        const proxyContext = { dbOps } as any;
        const accessToken = await getValidAccessToken(account, proxyContext);
        log.info(`Access token test: ${accessToken ? "PASS" : "FAIL"}`);

        if (accessToken) {
          // Test 5: Try to fetch usage data
          log.info("Test 5: Testing usage fetch...");
          const usageData = await fetchUsageData(accessToken);
          log.info(`Usage fetch test: ${usageData ? "PASS" : "FAIL"}`);
          if (usageData) {
            log.info(`Usage data: 5h=${usageData.five_hour.utilization}%, 7d=${usageData.seven_day.utilization}%`);
          }
        }
      } catch (error) {
        log.error(`Access token error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

  } catch (error) {
    log.error(`Debug script error:`, error);
  }
}

debugUsageIssue().then(() => {
  log.info("Debug script completed");
  process.exit(0);
}).catch((error) => {
  log.error("Debug script failed:", error);
  process.exit(1);
});