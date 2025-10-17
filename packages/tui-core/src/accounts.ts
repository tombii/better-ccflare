import * as cliCommands from "@better-ccflare/cli-commands";
import { openBrowser } from "@better-ccflare/cli-commands";
import { Config } from "@better-ccflare/config";
import { DatabaseFactory } from "@better-ccflare/database";
import { type BeginResult, createOAuthFlow } from "@better-ccflare/oauth-flow";
import type { AccountListItem, AddAccountOptions } from "@better-ccflare/types";

export interface OAuthFlowResult extends BeginResult {
	// Extends BeginResult from oauth-flow package
}

/**
 * Begin OAuth flow for adding an account (TUI version)
 * Returns the auth URL and PKCE data needed to complete the flow
 */
export async function beginAddAccount(
	options: AddAccountOptions,
): Promise<OAuthFlowResult> {
	const { name, mode = "max" } = options;

	// z.ai and openai-compatible accounts don't use OAuth flow
	if (mode === "zai") {
		throw new Error(
			"z.ai accounts should be added directly with API key, not via OAuth flow",
		);
	}
	if (mode === "openai-compatible") {
		throw new Error(
			"OpenAI-compatible accounts should be added directly with API key, not via OAuth flow",
		);
	}

	const config = new Config();
	const dbOps = DatabaseFactory.getInstance();

	// Create OAuth flow instance
	const oauthFlow = await createOAuthFlow(dbOps, config);

	// Begin OAuth flow
	const flowResult = await oauthFlow.begin({
		name,
		mode: mode as "max" | "console",
	});

	// Open browser
	console.log(`\nOpening browser to authenticate...`);
	console.log(`URL: ${flowResult.authUrl}`);
	const browserOpened = await openBrowser(flowResult.authUrl);
	if (!browserOpened) {
		console.log(
			`Please open the following URL in your browser:\n${flowResult.authUrl}`,
		);
	}

	return flowResult;
}

/**
 * Complete OAuth flow after receiving authorization code
 */
export async function completeAddAccount(
	options: AddAccountOptions & { code: string; flowData: OAuthFlowResult },
): Promise<void> {
	const {
		name,
		mode = "max",
		tier = 1,
		priority = 0,
		code,
		flowData,
	} = options;
	const config = new Config();
	const dbOps = DatabaseFactory.getInstance();

	// Create OAuth flow instance
	const oauthFlow = await createOAuthFlow(dbOps, config);

	// Complete OAuth flow
	console.log("\nExchanging code for tokens...");
	const _account = await oauthFlow.complete(
		{ sessionId: flowData.sessionId, code, tier, name, priority },
		flowData,
	);

	console.log(`\nAccount '${name}' added successfully!`);
	console.log(`Type: ${mode === "max" ? "Claude Max" : "Claude Console"}`);
	console.log(`Tier: ${tier}x`);
	console.log(`Priority: ${priority}`);
}

/**
 * Legacy function for non-TUI usage
 */
export async function addAccount(options: AddAccountOptions): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	const config = new Config();
	await cliCommands.addAccount(dbOps, config, {
		name: options.name,
		mode: options.mode || "max",
		tier: options.tier || 1,
		priority: options.priority || 0,
	});
}

export async function getAccounts(): Promise<AccountListItem[]> {
	const dbOps = DatabaseFactory.getInstance();
	return await cliCommands.getAccountsList(dbOps);
}

export async function removeAccount(name: string): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	await cliCommands.removeAccount(dbOps, name);
}

export async function pauseAccount(
	name: string,
): Promise<{ success: boolean; message: string }> {
	const dbOps = DatabaseFactory.getInstance();
	return cliCommands.pauseAccount(dbOps, name);
}

export async function resumeAccount(
	name: string,
): Promise<{ success: boolean; message: string }> {
	const dbOps = DatabaseFactory.getInstance();
	return cliCommands.resumeAccount(dbOps, name);
}

export async function updateAccountPriority(
	name: string,
	priority: number,
): Promise<{ success: boolean; message: string }> {
	const dbOps = DatabaseFactory.getInstance();
	return cliCommands.setAccountPriority(dbOps, name, priority);
}
