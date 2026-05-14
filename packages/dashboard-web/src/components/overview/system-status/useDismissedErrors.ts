import { NO_ACCOUNT_ID, type RecentErrorGroup } from "@better-ccflare/types";
import { useCallback, useState } from "react";

const STORAGE_KEY = "better-ccflare:dismissed-errors";
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function keyFor(group: RecentErrorGroup): string {
	return `${group.accountId ?? NO_ACCOUNT_ID}:${group.errorCode}`;
}

function readFromStorage(): Record<string, number> {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const cleaned: Record<string, number> = {};
			const now = Date.now();
			let pruned = false;
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof v === "number" && v + PRUNE_AFTER_MS > now) {
					cleaned[k] = v;
				} else {
					pruned = true;
				}
			}
			if (pruned) {
				writeToStorage(cleaned);
			}
			return cleaned;
		}
		return {};
	} catch {
		return {};
	}
}

function writeToStorage(state: Record<string, number>) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// ignore — degrade to in-memory
	}
}

export function useDismissedErrors() {
	const [state, setState] = useState<Record<string, number>>(readFromStorage);

	const dismiss = useCallback((group: RecentErrorGroup) => {
		setState((prev) => {
			const next = { ...prev, [keyFor(group)]: Date.now() };
			writeToStorage(next);
			return next;
		});
	}, []);

	const isDismissed = useCallback(
		(group: RecentErrorGroup) => {
			const dismissedBefore = state[keyFor(group)];
			return (
				dismissedBefore != null && group.latestTimestamp <= dismissedBefore
			);
		},
		[state],
	);

	const clearAll = useCallback(() => {
		setState({});
		writeToStorage({});
	}, []);

	return { dismiss, isDismissed, clearAll };
}
