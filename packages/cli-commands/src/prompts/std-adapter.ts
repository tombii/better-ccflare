import * as readline from "readline";
import type { PromptAdapter } from "./adapter";

/**
 * Read a line from stdin using readline (works in WSL and non-TTY contexts)
 */
function readLine(question: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

/**
 * Standard prompt adapter using readline (more reliable than Bun's prompt())
 */
export class StdPromptAdapter implements PromptAdapter {
	async select<T extends string | number>(
		question: string,
		options: Array<{ label: string; value: T }>,
	): Promise<T> {
		console.log(question);
		options.forEach((option, index) => {
			console.log(`${index + 1}) ${option.label}`);
		});

		const choice = await readLine(`Enter your choice (1-${options.length}): `);
		const index = parseInt(choice || "", 10) - 1;

		if (index < 0 || index >= options.length || Number.isNaN(index)) {
			throw new Error(
				`Invalid choice. Please enter a number between 1 and ${options.length}.`,
			);
		}

		return options[index].value;
	}

	async input(question: string, _mask?: boolean): Promise<string> {
		// Note: readline doesn't support masking, so we ignore the mask parameter
		const answer = await readLine(question);
		if (!answer) {
			throw new Error("Input is required");
		}
		return answer;
	}

	async confirm(question: string): Promise<boolean> {
		const answer = await readLine(`${question} (y/n): `);
		return answer?.toLowerCase().startsWith("y") || false;
	}
}

// Export singleton instance
export const stdPromptAdapter = new StdPromptAdapter();
