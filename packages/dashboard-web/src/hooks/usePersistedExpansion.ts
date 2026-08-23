import { useCallback, useState } from "react";

const EMPTY: string[] = [];

/**
 * Parses a raw localStorage value into an array of expanded row ids. Returns
 * [] ("nothing expanded") for null, invalid JSON, or non-array JSON --
 * corrupted/foreign content never throws, it always degrades to the safe
 * empty state.
 */
export function parseExpanded(raw: string | null): string[] {
	if (raw == null || raw === "") return EMPTY;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return EMPTY;
	}
	if (!Array.isArray(parsed)) return EMPTY;
	return parsed.filter((id): id is string => typeof id === "string");
}

/**
 * Toggles `id` in `list` without mutating it: removes it if present, appends
 * it if absent.
 */
export function toggleIn(list: string[], id: string): string[] {
	return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * Storage seam narrowed to the two methods usePersistedExpansion needs, so
 * the read/write logic below is directly testable with a plain mock object
 * -- no DOM environment (window/localStorage) required in tests.
 */
type StorageLike = Pick<Storage, "getItem" | "setItem">;

function getStorage(): StorageLike | undefined {
	if (typeof window === "undefined") return undefined;
	return window.localStorage;
}

/**
 * Reads the persisted expansion state. Robust against every failure mode a
 * real browser can hit: no storage object (SSR, storage disabled), a
 * getItem() call that throws (private-mode Safari), and corrupted/foreign
 * JSON content -- all degrade to "nothing expanded" rather than throwing.
 */
export function readExpanded(
	storageKey: string,
	storage: StorageLike | undefined,
): string[] {
	if (!storage) return EMPTY;
	try {
		return parseExpanded(storage.getItem(storageKey));
	} catch {
		return EMPTY;
	}
}

/**
 * Persists the expansion state. A storage write can throw too (quota
 * exceeded, private mode) -- swallow it and degrade to in-memory-only, the
 * same pattern the other localStorage-backed hooks in this codebase use
 * (useDismissedErrors, useErrorWindow, useAnalyticsUrlState).
 */
export function writeExpanded(
	storageKey: string,
	ids: string[],
	storage: StorageLike | undefined,
): void {
	if (!storage) return;
	try {
		storage.setItem(storageKey, JSON.stringify(ids));
	} catch {
		// ignore — degrade to in-memory only
	}
}

export interface UsePersistedExpansion {
	isExpanded: (id: string) => boolean;
	toggle: (id: string) => void;
	expandAll: (ids: string[]) => void;
	collapseAll: () => void;
	expandedCount: number;
}

/**
 * Tracks which pool rows are expanded, persisted to localStorage under
 * `storageKey` as a JSON array of ids. See readExpanded/writeExpanded above
 * for the storage failure modes this degrades gracefully from.
 */
export function usePersistedExpansion(
	storageKey: string,
): UsePersistedExpansion {
	const [expanded, setExpanded] = useState<string[]>(() =>
		readExpanded(storageKey, getStorage()),
	);

	const isExpanded = useCallback(
		(id: string) => expanded.includes(id),
		[expanded],
	);

	const toggle = useCallback(
		(id: string) => {
			setExpanded((prev) => {
				const next = toggleIn(prev, id);
				writeExpanded(storageKey, next, getStorage());
				return next;
			});
		},
		[storageKey],
	);

	const expandAll = useCallback(
		(ids: string[]) => {
			writeExpanded(storageKey, ids, getStorage());
			setExpanded(ids);
		},
		[storageKey],
	);

	const collapseAll = useCallback(() => {
		writeExpanded(storageKey, EMPTY, getStorage());
		setExpanded(EMPTY);
	}, [storageKey]);

	return {
		isExpanded,
		toggle,
		expandAll,
		collapseAll,
		expandedCount: expanded.length,
	};
}
