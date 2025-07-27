import type { PromptAdapter } from "./adapter";

/**
 * Standard prompt adapter using blocking prompt() calls
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

		const choice = prompt(`Enter your choice (${1}-${options.length}): `);
		const index = parseInt(choice || "", 10) - 1;

		if (index < 0 || index >= options.length || Number.isNaN(index)) {
			throw new Error(
				`Invalid choice. Please enter a number between 1 and ${options.length}.`,
			);
		}

		return options[index].value;
	}

	async input(question: string, _mask?: boolean): Promise<string> {
		// Note: Bun's prompt() doesn't support masking, so we ignore the mask parameter
		const answer = prompt(question);
		if (!answer) {
			throw new Error("Input is required");
		}
		return answer;
	}

	async confirm(question: string): Promise<boolean> {
		const answer = prompt(`${question} (y/n): `);
		return answer?.toLowerCase().startsWith("y") || false;
	}
}

// Export singleton instance
export const stdPromptAdapter = new StdPromptAdapter();
