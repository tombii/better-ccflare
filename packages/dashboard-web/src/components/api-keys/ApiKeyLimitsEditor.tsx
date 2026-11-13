import type {
	ApiKeyLimitStatus,
	ApiKeyLimitWindowMode,
} from "@better-ccflare/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { useModelOptions } from "../../hooks/queries";
import { queryKeys } from "../../lib/query-keys";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { type LimitDraft, limitDraftsOf, serializeLimits } from "./limits";
import { MODEL_FAMILIES } from "./restrictions";

export function ApiKeyLimitsEditor({
	keyId,
	limits,
	mode: initialMode = "calendar",
	onSaved,
}: {
	keyId: string;
	limits: ApiKeyLimitStatus[];
	mode?: ApiKeyLimitWindowMode;
	onSaved?: () => void;
}) {
	const queryClient = useQueryClient();
	const [mode, setMode] = useState(initialMode);
	const [drafts, setDrafts] = useState(() => limitDraftsOf(limits));
	const [error, setError] = useState<string | null>(null);
	const models = useModelOptions();
	const save = useMutation({
		mutationFn: () =>
			api.put(
				`/api/api-keys/${encodeURIComponent(keyId)}/limits`,
				serializeLimits(mode, drafts),
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
			queryClient.invalidateQueries({
				queryKey: [...queryKeys.all, "api-key-usage"],
			});
			setError(null);
			onSaved?.();
		},
	});
	const update = (id: string, patch: Partial<LimitDraft>) => {
		setDrafts((rows) =>
			rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
		);
		setError(null);
		save.reset();
	};
	const optionsId = `limit-models-${keyId}`;
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-3">
				<Label htmlFor={`calendar-limits-${keyId}`}>
					Calendar windows (Europe/Dublin)
				</Label>
				<Switch
					id={`calendar-limits-${keyId}`}
					checked={mode === "calendar"}
					disabled={save.isPending}
					onCheckedChange={(checked) => {
						setMode(checked ? "calendar" : "rolling");
						setError(null);
						save.reset();
					}}
				/>
			</div>
			<p className="text-xs text-muted-foreground">
				{mode === "calendar"
					? "Clock hour, day, week from Monday, and calendar month. Each window resets at its Dublin boundary."
					: "Trailing 60 minutes, 24 hours, 7 days, and 30 days. Spend falls as requests age out."}{" "}
				All limits count every request at API token rates.
			</p>
			<datalist id={optionsId}>
				{[
					...new Set([...MODEL_FAMILIES, ...models.map((model) => model.id)]),
				].map((model) => (
					<option key={model} value={model} />
				))}
			</datalist>
			{drafts.map((row) => (
				<fieldset
					key={row.id}
					disabled={save.isPending}
					className="rounded-md border p-3 space-y-3"
				>
					<legend className="px-1 text-xs text-muted-foreground">
						{row.scopeModel || "Whole key"} / {row.window}
					</legend>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<Label htmlFor={`scope-${row.id}`}>Model scope</Label>
							<Input
								id={`scope-${row.id}`}
								list={optionsId}
								placeholder="Whole key (all models)"
								value={row.scopeModel}
								onChange={(event) =>
									update(row.id, { scopeModel: event.target.value })
								}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`usd-${row.id}`}>API cost limit (USD)</Label>
							<Input
								id={`usd-${row.id}`}
								inputMode="decimal"
								placeholder="5.00"
								value={row.usd}
								onChange={(event) =>
									update(row.id, { usd: event.target.value })
								}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`window-${row.id}`}>Window</Label>
							<Select
								value={row.window}
								onValueChange={(window) =>
									update(row.id, { window: window as LimitDraft["window"] })
								}
							>
								<SelectTrigger id={`window-${row.id}`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{["hour", "day", "week", "month"].map((window) => (
										<SelectItem key={window} value={window}>
											{window}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`enforce-${row.id}`}>When exceeded</Label>
							<Select
								value={row.enforce}
								onValueChange={(enforce) =>
									update(row.id, { enforce: enforce as LimitDraft["enforce"] })
								}
							>
								<SelectTrigger id={`enforce-${row.id}`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="block">Block (HTTP 429)</SelectItem>
									<SelectItem value="warn">Warn only</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setDrafts((rows) => rows.filter((draft) => draft.id !== row.id));
							setError(null);
							save.reset();
						}}
					>
						<Trash2 className="h-4 w-4 mr-2" />
						Remove limit
					</Button>
				</fieldset>
			))}
			{drafts.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No spend limits. Add a whole-key limit or a limit for an exact model
					ID or family.
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					disabled={save.isPending}
					onClick={() => {
						setDrafts((rows) => [
							...rows,
							{
								id: crypto.randomUUID(),
								scopeModel: "",
								window: "day",
								usd: "",
								enforce: "block",
							},
						]);
						setError(null);
						save.reset();
					}}
				>
					<Plus className="h-4 w-4 mr-2" />
					Add limit
				</Button>
				<Button
					disabled={save.isPending}
					onClick={() => {
						try {
							serializeLimits(mode, drafts);
							setError(null);
							save.mutate();
						} catch (reason) {
							setError(
								reason instanceof Error ? reason.message : "Invalid limits",
							);
						}
					}}
				>
					{save.isPending ? "Saving..." : "Save limits"}
				</Button>
			</div>
			{error || save.isError ? (
				<p role="alert" className="text-sm text-destructive">
					{error ??
						(save.error instanceof Error
							? save.error.message
							: "Failed to save limits.")}
				</p>
			) : null}
			{save.isSuccess ? (
				<p role="status" className="text-sm text-muted-foreground">
					Limits saved.
				</p>
			) : null}
		</div>
	);
}
