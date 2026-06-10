import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { FilterState } from "../components/analytics/AnalyticsFilters";
import type { TimeRange } from "../constants";
import {
	type AnalyticsUrlState,
	decodeAnalyticsState,
	encodeAnalyticsState,
	hasAnalyticsParams,
	normalizeState,
} from "../lib/analytics-url-state";

const STORAGE_KEY = "better-ccflare:analytics-state";

function readStoredState(): AnalyticsUrlState | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		return normalizeState(JSON.parse(raw));
	} catch {
		return null;
	}
}

function writeStoredState(state: AnalyticsUrlState): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// ignore — storage unavailable / quota; the URL still holds the state
	}
}

export interface UseAnalyticsUrlState {
	timeRange: TimeRange;
	selectedMetric: string;
	viewMode: "normal" | "cumulative";
	modelBreakdown: boolean;
	filters: FilterState;
	setTimeRange: (range: TimeRange) => void;
	setSelectedMetric: (metric: string) => void;
	setViewMode: (mode: "normal" | "cumulative") => void;
	setModelBreakdown: (value: boolean) => void;
	setFilters: (filters: FilterState) => void;
}

/**
 * Syncs the Analytics page view controls with the URL query string (single
 * source of truth) and localStorage (seed/backup). Drop-in for the 5 useState
 * calls AnalyticsTab previously held.
 */
export function useAnalyticsUrlState(): UseAnalyticsUrlState {
	const [searchParams, setSearchParams] = useSearchParams();

	// The URL is the single source of truth for analytics view state.
	const state = useMemo(
		() => decodeAnalyticsState(searchParams),
		[searchParams],
	);

	// On first mount, if the URL has no analytics params, seed it from the saved
	// preference using replace (no new history entry). The `didSeed` guard makes
	// this run exactly once: without it, re-running when `searchParams` changes
	// would re-seed the stored value and fight the user when they reset a control
	// back to its default. `skipMirror` stops the persistence effect below from
	// clobbering the saved value with defaults during the pre-seed render.
	const didSeed = useRef(false);
	const skipMirror = useRef(false);
	useEffect(() => {
		if (didSeed.current) return;
		didSeed.current = true;
		if (hasAnalyticsParams(searchParams)) return;
		const stored = readStoredState();
		if (!stored) return;
		const seeded = encodeAnalyticsState(stored);
		if (seeded.toString() === "") return;
		skipMirror.current = true;
		setSearchParams(seeded, { replace: true });
	}, [searchParams, setSearchParams]);

	// Mirror the active state to localStorage so the next visit can restore it.
	useEffect(() => {
		if (skipMirror.current) {
			skipMirror.current = false;
			return;
		}
		writeStoredState(state);
	}, [state]);

	const setField = useCallback(
		<K extends keyof AnalyticsUrlState>(
			key: K,
			value: AnalyticsUrlState[K],
		) => {
			setSearchParams(
				(prev) =>
					encodeAnalyticsState(
						normalizeState({ ...decodeAnalyticsState(prev), [key]: value }),
					),
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	const setTimeRange = useCallback(
		(range: TimeRange) => setField("timeRange", range),
		[setField],
	);
	const setSelectedMetric = useCallback(
		(metric: string) => setField("selectedMetric", metric),
		[setField],
	);
	const setViewMode = useCallback(
		(mode: "normal" | "cumulative") => setField("viewMode", mode),
		[setField],
	);
	const setModelBreakdown = useCallback(
		(value: boolean) => setField("modelBreakdown", value),
		[setField],
	);
	const setFilters = useCallback(
		(filters: FilterState) => setField("filters", filters),
		[setField],
	);

	return {
		timeRange: state.timeRange,
		selectedMetric: state.selectedMetric,
		viewMode: state.viewMode,
		modelBreakdown: state.modelBreakdown,
		filters: state.filters,
		setTimeRange,
		setSelectedMetric,
		setViewMode,
		setModelBreakdown,
		setFilters,
	};
}
