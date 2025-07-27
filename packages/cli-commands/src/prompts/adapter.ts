/**
 * Prompt adapter interface for abstracting user input collection
 */
export interface PromptAdapter {
	/**
	 * Present a selection menu to the user
	 * @param question The question to ask
	 * @param options Array of options with label and value
	 * @returns Promise resolving to the selected value
	 */
	select<T extends string | number>(
		question: string,
		options: Array<{ label: string; value: T }>,
	): Promise<T>;

	/**
	 * Get text input from the user
	 * @param question The question to ask
	 * @param mask Whether to mask the input (for passwords)
	 * @returns Promise resolving to the entered text
	 */
	input(question: string, mask?: boolean): Promise<string>;

	/**
	 * Get a yes/no confirmation from the user
	 * @param question The question to ask
	 * @returns Promise resolving to true if confirmed, false otherwise
	 */
	confirm(question: string): Promise<boolean>;
}
