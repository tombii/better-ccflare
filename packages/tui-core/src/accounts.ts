import type { AccountListItem } from "@claudeflare/cli-commands";
import * as cliCommands from "@claudeflare/cli-commands";
import { Config } from "@claudeflare/config";
import { DatabaseOperations } from "@claudeflare/database";

export interface AddAccountOptions {
	name: string;
	mode?: "max" | "console";
	tier?: 1 | 5 | 20;
}

export async function addAccount(options: AddAccountOptions): Promise<void> {
	const dbOps = new DatabaseOperations();
	const config = new Config();
	await cliCommands.addAccount(dbOps, config, options);
}

export async function getAccounts(): Promise<AccountListItem[]> {
	const dbOps = new DatabaseOperations();
	return await cliCommands.getAccountsList(dbOps);
}

export async function removeAccount(name: string): Promise<void> {
	const dbOps = new DatabaseOperations();
	await cliCommands.removeAccount(dbOps, name);
}
