/**
 * Prompt user to select account mode
 */
export async function promptAccountMode(): Promise<"max" | "console"> {
	console.log("What type of account would you like to add?");
	console.log("1) Claude Max account");
	console.log("2) Claude Console account");
	const choice = prompt("Enter your choice (1 or 2): ");

	if (choice === "1") {
		return "max";
	} else if (choice === "2") {
		return "console";
	} else {
		throw new Error("Invalid choice. Please enter 1 or 2.");
	}
}

/**
 * Prompt user to select account tier
 */
export async function promptAccountTier(): Promise<1 | 5 | 20> {
	console.log(
		"Select the tier for this account (used for weighted load balancing):",
	);
	console.log("1) 1x tier (default free account)");
	console.log("2) 5x tier (paid account)");
	console.log("3) 20x tier (enterprise account)");
	const choice = prompt("Enter your choice (1, 2, or 3): ");

	if (choice === "1") {
		return 1;
	} else if (choice === "2") {
		return 5;
	} else if (choice === "3") {
		return 20;
	} else {
		throw new Error("Invalid choice. Please enter 1, 2, or 3.");
	}
}

/**
 * Prompt user to enter authorization code
 */
export async function promptAuthorizationCode(): Promise<string> {
	const code = prompt("\nEnter the authorization code: ");
	if (!code) {
		throw new Error("Authorization code is required");
	}
	return code;
}

/**
 * Prompt user to confirm account removal
 */
export async function promptAccountRemovalConfirmation(accountName: string): Promise<boolean> {
	console.log(`\n⚠️  WARNING: You are about to remove the account '${accountName}'`);
	console.log("This action cannot be undone.");
	console.log("\nTo confirm, please type the account name exactly:");
	
	const confirmation = prompt(`Type '${accountName}' to confirm deletion: `);
	
	if (!confirmation) {
		return false;
	}
	
	return confirmation === accountName;
}
