import type { ModelRouting } from "@better-ccflare/core";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

/**
 * Inline editor for the inference-provider routing suffix of ONE model field.
 *
 * The routing object is per model (per combo slot, per list element), not per
 * account: the same account may pin one model to one upstream provider and
 * another model to a different one.
 *
 * No Radix Popover here on purpose: the component is rendered under the model
 * input, and nesting popovers inside the combobox popover causes focus fights.
 * Every change is written straight through `onChange`; there is no local draft
 * of the routing object — only the slug being typed is local state.
 */

export type RoutingMode = "any" | "only" | "ignore";

const DEFAULT_SORT = "__default__";

const SORT_LABELS: Record<string, string> = {
	price: "price",
	throughput: "throughput",
	latency: "latency",
};

export function routingModeOf(routing: ModelRouting | null): RoutingMode {
	if (routing?.only?.length) return "only";
	if (routing?.ignore?.length) return "ignore";
	return "any";
}

/** One-line summary for compact rows: "only: deepseek" / "exclude: a, b". */
export function summarizeRouting(routing: ModelRouting | null): string {
	const parts: string[] = [];
	const mode = routingModeOf(routing);
	if (mode === "only") parts.push(`only: ${(routing?.only ?? []).join(", ")}`);
	if (mode === "ignore")
		parts.push(`exclude: ${(routing?.ignore ?? []).join(", ")}`);
	if (routing?.sort && SORT_LABELS[routing.sort])
		parts.push(`sort: ${SORT_LABELS[routing.sort]}`);
	if (routing?.allow_fallbacks === false) parts.push("no fallbacks");
	return parts.join(" · ");
}

interface ModelRoutingPanelProps {
	provider: string | null | undefined;
	routing: ModelRouting | null;
	/** Receives the next routing object, or null for "any provider". */
	onChange: (routing: ModelRouting | null) => void;
	/**
	 * List mode only: the segmented selector for the list element being
	 * edited. Labels are the stripped models; `index` is which one is current.
	 */
	segments?: {
		labels: string[];
		index: number;
		onSelect: (index: number) => void;
	};
	/**
	 * When set, the panel is shown read-only (no list element to edit) with
	 * this explanation.
	 */
	emptyHint?: string | null;
}

function slugify(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Drop keys that carry no decision, so "any provider" really means a bare
 * model string. `only`/`ignore` as empty arrays are what the UI produces
 * mid-edit (chosen a mode, typed nothing yet) — they must not be stored.
 *
 * Everything else is passed through UNTOUCHED: the panel edits only
 * `only`/`ignore`/`sort`/`allow_fallbacks`, and a hand-written (or
 * future-UI) suffix can also carry `order`, `max_price`, `data_collection`,
 * `require_parameters`, `quantizations`. Rebuilding the object from the
 * panel's fields alone would silently erase those on every provider-list
 * edit, so start from the incoming routing and only change what we own.
 */
function pruneRouting(routing: ModelRouting | null): ModelRouting | null {
	if (!routing) return null;
	const next: ModelRouting = { ...routing };
	// `only` and `ignore` are mutually exclusive: whichever mode is active
	// wins and the other is removed. `only` wins, as it did before.
	delete next.only;
	delete next.ignore;
	if (routing.only?.length) next.only = routing.only;
	else if (routing.ignore?.length) next.ignore = routing.ignore;
	if (!routing.sort) delete next.sort;
	if (routing.allow_fallbacks === undefined) delete next.allow_fallbacks;
	return Object.keys(next).length > 0 ? next : null;
}

/**
 * Next routing after the mode radio changes.
 *
 * "Any provider" means no routing object at all: sort and the fallback opt-out
 * are properties of a pinned/excluded choice, so they go with it. Only the
 * slugs of the newly chosen mode's list survive a switch between the two.
 */
export function applyRoutingMode(
	current: ModelRouting | null,
	mode: RoutingMode,
): ModelRouting | null {
	if (mode === "any") return null;
	if (mode === "only") {
		// "Only these" leaves a single upstream candidate: sort and the fallback
		// opt-out have nothing to act on, so they are not emitted at all.
		return pruneRouting({ only: current?.only ?? [] });
	}
	return pruneRouting({
		ignore: current?.ignore ?? [],
		sort: current?.sort,
		allow_fallbacks: current?.allow_fallbacks,
	});
}

/** Next routing after adding a slug to the current mode's list. */
export function addRoutingSlug(
	current: ModelRouting | null,
	mode: RoutingMode,
	raw: string,
): ModelRouting | null {
	if (mode === "any") return current;
	// A paste of "a, b, c" or "a,b" is several slugs.
	const added = raw.split(",").map(slugify).filter(Boolean);
	if (added.length === 0) return current;
	const key = mode === "only" ? "only" : "ignore";
	const existing = current?.[key] ?? [];
	const merged = [...existing];
	for (const slug of added) if (!merged.includes(slug)) merged.push(slug);
	if (merged.length === existing.length) return current;
	return pruneRouting({ ...(current ?? {}), [key]: merged });
}

/**
 * Next routing after committing the whole draft. Always ONE call: the draft
 * can hold several slugs ("deepseek, novita"), and adding them one at a time
 * would each rebuild from the same pre-commit `routing` value, discarding
 * every slug but the last. Returns `current` when nothing new was added.
 */
export function commitRoutingDraft(
	current: ModelRouting | null,
	mode: RoutingMode,
	draft: string,
): ModelRouting | null {
	return addRoutingSlug(current, mode, draft);
}

export function ModelRoutingPanel({
	provider,
	routing,
	onChange,
	segments,
	emptyHint,
}: ModelRoutingPanelProps) {
	const [draft, setDraft] = useState("");
	// Radios sharing a name form one group page-wide; several model fields can
	// be on screen at once (one per family in the mappings dialog).
	const modeGroup = useId();
	// A mode chosen before any slug is typed exists ONLY locally: `{"only":[]}`
	// is not worth storing, and deriving the mode from the stored object would
	// bounce the radio back to "Any provider" the moment it is picked.
	const [pendingMode, setPendingMode] = useState<RoutingMode | null>(null);
	const disabled = Boolean(emptyHint);
	const mode = pendingMode ?? routingModeOf(routing);
	const slugs =
		mode === "only" ? (routing?.only ?? []) : (routing?.ignore ?? []);
	const isNanogpt = (provider ?? "").trim() === "nanogpt";

	// The draft and any pending mode belong to ONE list element: switching
	// segments starts a fresh edit on the element's own routing.
	const segmentsKey = `${segments?.index ?? 0}`;
	const lastKey = useRef(segmentsKey);
	useEffect(() => {
		if (lastKey.current !== segmentsKey) {
			lastKey.current = segmentsKey;
			setDraft("");
			setPendingMode(null);
		}
	}, [segmentsKey]);

	const setMode = (next: RoutingMode) => {
		const applied = applyRoutingMode(routing, next);
		// "Any" is derivable from the stored object; a pinned/excluded mode with
		// no slug yet is not, so it has to live in local state.
		setPendingMode(next === "any" ? null : next);
		onChange(applied);
	};

	const setSlugs = (nextSlugs: string[]) => {
		if (mode === "any") return;
		const key = mode === "only" ? "only" : "ignore";
		onChange(pruneRouting({ ...(routing ?? {}), [key]: nextSlugs }));
	};

	const addSlug = (raw: string) => {
		const next = addRoutingSlug(routing, mode, raw);
		if (next !== routing) onChange(next);
	};

	const handleDraftKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			addSlug(draft);
			setDraft("");
			return;
		}
		if (e.key === "Backspace" && draft === "" && slugs.length > 0) {
			setSlugs(slugs.slice(0, -1));
		}
	};

	const setSort = (value: string) => {
		const sort =
			value === "price" || value === "throughput" || value === "latency"
				? value
				: undefined;
		onChange(pruneRouting({ ...(routing ?? {}), sort }));
	};

	return (
		<div
			className={cn(
				"mt-1.5 space-y-2 rounded-md border bg-background p-2 text-xs",
				disabled && "opacity-60",
			)}
			data-testid="model-routing-panel"
		>
			{segments && segments.labels.length > 0 && (
				<div className="flex flex-wrap items-center gap-1">
					<span className="mr-1 text-[11px] text-muted-foreground">
						Routing for:
					</span>
					{segments.labels.map((label, index) => (
						<button
							// Labels are model names and can repeat; index is the identity.
							// biome-ignore lint/suspicious/noArrayIndexKey: identity is the position
							key={index}
							type="button"
							onClick={() => segments.onSelect(index)}
							className={cn(
								"rounded-full border px-2 py-0.5 font-mono text-[11px]",
								index === segments.index
									? "border-primary bg-primary text-primary-foreground"
									: "hover:bg-accent",
							)}
							title={label}
						>
							<span className="inline-block max-w-[10rem] truncate align-bottom">
								{label}
							</span>
						</button>
					))}
				</div>
			)}

			{disabled && emptyHint && (
				<p className="text-[11px] text-muted-foreground">{emptyHint}</p>
			)}

			<fieldset disabled={disabled} className="space-y-2">
				<legend className="sr-only">Upstream provider selection</legend>
				<div className="flex flex-wrap items-center gap-3">
					{(
						[
							["any", "Any provider"],
							["only", "Only these"],
							["ignore", "Exclude these"],
						] as const
					).map(([value, label]) => (
						<label
							key={value}
							className="flex cursor-pointer items-center gap-1.5"
						>
							<input
								type="radio"
								name={modeGroup}
								value={value}
								checked={mode === value}
								onChange={() => setMode(value)}
							/>
							{label}
						</label>
					))}
				</div>

				{mode !== "any" && (
					<>
						<div className="flex flex-wrap items-center gap-1">
							{slugs.map((slug) => (
								<Badge
									key={slug}
									variant="secondary"
									className="gap-1 font-mono text-[11px] font-normal"
								>
									{slug}
									<button
										type="button"
										onClick={() => setSlugs(slugs.filter((s) => s !== slug))}
										aria-label={`Remove ${slug}`}
										className="text-muted-foreground hover:text-foreground"
									>
										<X className="h-3 w-3" />
									</button>
								</Badge>
							))}
							<Input
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={handleDraftKey}
								onBlur={() => {
									if (draft.trim()) {
										addSlug(draft);
										setDraft("");
									}
								}}
								placeholder="deepseek, novita, cloudflare"
								aria-label="Add upstream provider slug"
								className="h-7 w-56 font-mono text-xs"
								autoComplete="off"
								spellCheck={false}
							/>
						</div>

						{/* Sort and fallbacks only matter with MORE than one candidate. */}
						{mode === "ignore" && (
							<div className="flex flex-wrap items-center gap-3">
								{/* Radix Select is not a native control: a <label> for it trips a11y lint. */}
								<div className="flex items-center gap-1.5">
									<span
										id="model-routing-sort-label"
										className="text-muted-foreground"
									>
										Sort
									</span>
									<Select
										// Radix Select reserves "" for "no value", so the
										// default sort is a sentinel no provider sort uses.
										value={routing?.sort ?? DEFAULT_SORT}
										onValueChange={setSort}
									>
										<SelectTrigger className="h-7 w-36 text-xs">
											<SelectValue placeholder="default" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={DEFAULT_SORT}>default</SelectItem>
											<SelectItem value="price">price</SelectItem>
											<SelectItem value="throughput">throughput</SelectItem>
											<SelectItem value="latency">latency</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<label className="flex cursor-pointer items-center gap-1.5">
									<input
										type="checkbox"
										checked={routing?.allow_fallbacks !== false}
										onChange={(e) =>
											onChange(
												pruneRouting({
													...(routing ?? {}),
													allow_fallbacks: e.target.checked ? undefined : false,
												}),
											)
										}
									/>
									Allow fallbacks
								</label>
							</div>
						)}

						{isNanogpt && (
							<p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-500">
								<Badge
									variant="warning"
									className="shrink-0 px-1.5 py-0 text-[10px]"
								>
									billing
								</Badge>
								A pinned provider is billed pay-as-you-go and does not use this
								account's subscription quota.
							</p>
						)}
					</>
				)}
			</fieldset>
		</div>
	);
}
