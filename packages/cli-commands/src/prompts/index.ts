import { stdPromptAdapter } from "./std-adapter";

// Re-export adapter types
export type { PromptAdapter } from "./adapter";
export { StdPromptAdapter, stdPromptAdapter } from "./std-adapter";

/**
 * Prompt user to select account mode
 */
export async function promptAccountMode(): Promise<"max" | "console"> {
	return stdPromptAdapter.select(
		"What type of account would you like to add?",
		[
			{ label: "Claude Max account", value: "max" },
			{ label: "Claude Console account", value: "console" },
		],
	);
}

/**
 * Prompt user to enter authorization code
 */
export async function promptAuthorizationCode(): Promise<string> {
	return stdPromptAdapter.input("\nEnter the authorization code: ");
}

/**
 * Prompt user to confirm account removal
 */
export async function promptAccountRemovalConfirmation(
	accountName: string,
): Promise<boolean> {
	console.log(
		`\n⚠️  WARNING: You are about to remove the account '${accountName}'`,
	);
	console.log("This action cannot be undone.");
	console.log("\nTo confirm, please type the account name exactly:");

	const confirmation = prompt(`Type '${accountName}' to confirm deletion: `);

	if (!confirmation) {
		return false;
	}

	return confirmation === accountName;
}
