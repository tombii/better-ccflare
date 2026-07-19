import type {
	AgentAttributionSource,
	ProjectAttributionSource,
} from "@better-ccflare/types";

/**
 * Maps a raw attribution source enum value to a short human label.
 * Returns null for "none"/undefined so callers can render nothing when
 * there's no meaningful provenance to show.
 */
export function attributionSourceLabel(
	source?: ProjectAttributionSource | AgentAttributionSource | null,
): string | null {
	switch (source) {
		case "header_project":
		case "header_agent":
			return "header";
		case "path_project":
			return "path";
		case "heading_project":
			return "heading";
		case "prompt_agent":
			return "prompt";
		default:
			return null; // "none" / undefined -> no badge
	}
}
