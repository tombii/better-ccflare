/**
 * Provider routing expressed as a suffix on a model string.
 *
 * OpenRouter and NanoGPT both accept a `provider` object in the request body
 * that pins or excludes the upstream inference providers serving a request. We
 * let operators write that object inline, after the model name:
 *
 *   z-ai/glm-4.5-air:free {"ignore":["deepseek"], "sort":"price"}
 *
 * The suffix travels everywhere a model name can be configured — combo slot
 * models and account model_mappings values (including each element of a
 * string[] fallback list) — so this module owns both the model↔suffix split and
 * the comma-aware list splitter used by the dashboard's model fields.
 */

/** The subset of OpenRouter's `provider` object we forward. */
export interface ModelRouting {
	only?: string[];
	ignore?: string[];
	order?: string[];
	sort?: string;
	allow_fallbacks?: boolean;
	require_parameters?: boolean;
	data_collection?: "allow" | "deny";
	max_price?: Record<string, unknown>;
	quantizations?: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const slugs = value
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim().toLowerCase())
		.filter(Boolean);
	return slugs.length > 0 ? slugs : undefined;
}

/**
 * Coerce an arbitrary parsed value into a ModelRouting. Never throws: unknown
 * keys are ignored and wrong-typed values are dropped. Returns null when
 * nothing usable is left (e.g. `{}`), which callers treat as "no routing".
 */
export function sanitizeModelRouting(value: unknown): ModelRouting | null {
	if (!isPlainObject(value)) return null;

	const routing: ModelRouting = {};

	const only = slugList(value.only);
	const ignore = slugList(value.ignore);
	// `only` and `ignore` are mutually exclusive: an allow-list and a deny-list
	// cannot both be honoured by one upstream choice, and sending both risks
	// an empty candidate set. `only` wins because it is the narrower, more
	// explicit statement of what the operator wants to run on.
	if (only) routing.only = only;
	else if (ignore) routing.ignore = ignore;

	const order = slugList(value.order);
	if (order) routing.order = order;

	if (typeof value.sort === "string" && value.sort.trim())
		routing.sort = value.sort.trim();
	if (typeof value.allow_fallbacks === "boolean")
		routing.allow_fallbacks = value.allow_fallbacks;
	if (typeof value.require_parameters === "boolean")
		routing.require_parameters = value.require_parameters;
	if (value.data_collection === "allow" || value.data_collection === "deny")
		routing.data_collection = value.data_collection;
	if (isPlainObject(value.max_price))
		routing.max_price = { ...value.max_price };
	const quantizations = slugList(value.quantizations);
	if (quantizations) routing.quantizations = quantizations;

	return Object.keys(routing).length > 0 ? routing : null;
}

/**
 * Split a model string into its model id and trailing routing suffix.
 *
 * Only a trailing JSON object literal counts as routing — it must end the
 * string and start at a `{` that begins the last brace-balanced group. Braces
 * inside the model id (e.g. `some/{weird}/model`) are therefore never taken for
 * a suffix. A trailing `{...}` that is not valid JSON is NOT removed: routing
 * is null and the whole string is returned verbatim, so the malformed suffix
 * surfaces as an upstream rejection instead of silently running a different
 * model after characters were chopped off.
 */
export function splitModelRouting(model: string): {
	model: string;
	routing: ModelRouting | null;
} {
	const trimmedEnd = model.trimEnd();
	if (!trimmedEnd.endsWith("}")) return { model, routing: null };

	// Walk backwards to the matching `{`, tracking nesting and skipping braces
	// inside JSON strings.
	let depth = 0;
	let inString = false;
	let escaped = false;
	let start = -1;
	for (let i = trimmedEnd.length - 1; i >= 0; i--) {
		const ch = trimmedEnd[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "}") {
			depth++;
		} else if (ch === "{") {
			depth--;
			if (depth === 0) {
				start = i;
				break;
			}
		}
	}
	// Unbalanced, or the object starts the string (no model before it).
	if (start <= 0) return { model, routing: null };
	// The `{` must begin a new token, not sit inside the model id.
	if (!/\s/.test(trimmedEnd[start - 1])) return { model, routing: null };

	const modelPart = trimmedEnd.slice(0, start).trim();
	if (!modelPart) return { model, routing: null };

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmedEnd.slice(start));
	} catch {
		return { model, routing: null };
	}
	const routing = sanitizeModelRouting(parsed);
	if (!routing) return { model: modelPart, routing: null };
	return { model: modelPart, routing };
}

/** The model id with any routing suffix removed. */
export function stripModelRouting(model: string): string {
	return splitModelRouting(model).model;
}

/** Re-attach a routing object to a model id. */
export function formatModelRouting(
	model: string,
	routing: ModelRouting | null,
): string {
	const name = model.trim();
	const clean = routing ? sanitizeModelRouting(routing) : null;
	return clean ? `${name} ${JSON.stringify(clean)}` : name;
}

/**
 * Split a comma-separated model list on commas at brace depth 0 and trim.
 *
 * Commas inside a routing object are part of the JSON, not list separators.
 * Lives in core so the dashboard's model field and the proxy cannot drift.
 */
export function splitRoutingAwareList(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let current = "";
	for (const ch of value) {
		if (inString) {
			current += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			if (depth > 0) depth--;
		} else if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	parts.push(current);
	return parts.map((p) => p.trim()).filter(Boolean);
}
