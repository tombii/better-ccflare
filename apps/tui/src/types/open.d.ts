declare module "open" {
	interface OpenOptions {
		wait?: boolean;
		background?: boolean;
		newInstance?: boolean;
		allowNonzeroExitCode?: boolean;
		app?: {
			name: string | readonly string[];
			arguments?: readonly string[];
		};
	}
	function open(target: string, options?: OpenOptions): Promise<void>;
	export default open;
}
