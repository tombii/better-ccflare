import { createHash } from "node:crypto";
import { asText } from "./sanitize";
import type { ResponseItem, ResponsesRequest, ResponsesTool } from "./types";

/** Collect Responses Lite tool declarations without changing native input. */
export function getRequestTools(
	req: Pick<ResponsesRequest, "tools" | "input">,
): ResponsesTool[] {
	const declarations: ResponsesTool[] = [];
	if (Array.isArray(req.input)) {
		for (const rawItem of req.input as unknown[]) {
			// `input` is untrusted client JSON: skip anything that is not a plain
			// object before reading `.type`.
			if (
				rawItem === null ||
				typeof rawItem !== "object" ||
				Array.isArray(rawItem)
			) {
				continue;
			}
			const item = rawItem as ResponseItem;
			if (item.type === "additional_tools" && Array.isArray(item.tools)) {
				declarations.push(...item.tools);
			}
		}
	}
	if (Array.isArray(req.tools)) declarations.push(...req.tools);
	return flattenTools(declarations);
}

function flattenTools(tools: ResponsesTool[]): ResponsesTool[] {
	const result = new Map<string, ResponsesTool>();
	const visit = (
		declarations: ResponsesTool[],
		namespace?: string,
		description?: string,
	): void => {
		for (const rawTool of declarations as unknown[]) {
			// Tool declarations are untrusted client JSON as well, so a null,
			// primitive or array entry must not be dereferenced.
			if (
				rawTool === null ||
				typeof rawTool !== "object" ||
				Array.isArray(rawTool)
			) {
				continue;
			}
			const tool = rawTool as ResponsesTool;
			// Branching stays on `tool.type` so the union still narrows; only the
			// text-producing sites use asText(). A strict `===` never coerces, so
			// a non-string `type` simply falls through to the else branch.
			if (tool.type === "namespace") {
				// `tool.name` is interpolated into the child namespace and
				// `tool.description` is joined below, so neither may be a
				// non-string: an object with a null `toString` throws on
				// coercion.
				const toolName = asText(tool.name);
				visit(
					Array.isArray(tool.tools) ? tool.tools : [],
					namespace ? `${namespace}.${toolName ?? ""}` : toolName,
					[asText(description), asText(tool.description)]
						.filter(Boolean)
						.join("\n\n"),
				);
			} else if (tool.type === "function" || tool.type === "custom") {
				const effectiveNamespace = namespace ?? asText(tool.namespace);
				const effectiveTool = effectiveNamespace
					? {
							...tool,
							namespace: effectiveNamespace,
							description: [asText(description), asText(tool.description)]
								.filter(Boolean)
								.join("\n\n"),
						}
					: tool;
				result.set(
					JSON.stringify([effectiveNamespace, tool.name]),
					effectiveTool,
				);
			} else {
				result.set(JSON.stringify([namespace, tool.type]), tool);
			}
		}
	};
	visit(tools);
	return [...result.values()];
}

/** Anthropic names are flat and limited to 64 ASCII identifier characters. */
export function getTranslatedToolName(
	name: string,
	namespace?: string,
): string {
	// `name` comes from untrusted client JSON and is not guaranteed to be a
	// string; the namespace branch below would otherwise throw on `.replace`.
	// Only a string is used verbatim — anything else degrades to an empty name
	// rather than being coerced, so a hostile toString cannot throw either.
	const safeName = asText(name) ?? "";
	if (!namespace) return safeName;
	const digest = createHash("sha256")
		.update(JSON.stringify([namespace, safeName]))
		.digest("hex")
		.slice(0, 24);
	return `ns_${digest}_${safeName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 36)}`;
}

export function getResponseToolIdentity(
	name: string,
	tools: ResponsesTool[] = [],
): { name: string; namespace?: string } {
	for (const tool of flattenTools(tools)) {
		if (
			(tool.type === "function" || tool.type === "custom") &&
			getTranslatedToolName(tool.name, tool.namespace) === name
		) {
			return tool.namespace
				? { name: tool.name, namespace: tool.namespace }
				: { name: tool.name };
		}
	}
	return { name };
}

export function getCustomToolNames(tools: ResponsesTool[] = []): Set<string> {
	return new Set(
		flattenTools(tools)
			.filter((tool) => tool.type === "custom")
			.map((tool) => getTranslatedToolName(tool.name, tool.namespace)),
	);
}

/** Unwrap the JSON schema bridge without changing the tool's raw text. */
export function unwrapCustomToolInput(input: unknown): string {
	if (
		input !== null &&
		typeof input === "object" &&
		"input" in input &&
		typeof input.input === "string"
	) {
		return input.input;
	}
	throw new Error("Upstream custom tool call did not contain a text input");
}
