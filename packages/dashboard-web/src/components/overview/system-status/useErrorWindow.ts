import { useCallback, useState } from "react";

export type ErrorWindowKey = "1h" | "24h" | "7d" | "all";

const STORAGE_KEY = "better-ccflare:errors:window";
const DEFAULT: ErrorWindowKey = "24h";
const HOURS: Record<ErrorWindowKey, number> = {
	"1h": 1,
	"24h": 24,
	"7d": 168,
	all: 8760,
};

function readFromStorage(): ErrorWindowKey {
	if (typeof window === "undefined") return DEFAULT;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw === "1h" || raw === "24h" || raw === "7d" || raw === "all") {
			return raw;
		}
		return DEFAULT;
	} catch {
		return DEFAULT;
	}
}

function writeToStorage(key: ErrorWindowKey) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, key);
	} catch {
		// ignore
	}
}

export function useErrorWindow() {
	const [windowKey, setWindowKeyState] =
		useState<ErrorWindowKey>(readFromStorage);
	const setWindowKey = useCallback((k: ErrorWindowKey) => {
		setWindowKeyState(k);
		writeToStorage(k);
	}, []);
	return { windowKey, setWindowKey, windowHours: HOURS[windowKey] };
}
