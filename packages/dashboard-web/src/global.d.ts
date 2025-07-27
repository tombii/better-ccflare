/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

declare global {
	interface Window {
		EventSource: typeof EventSource;
	}
}

export {};
