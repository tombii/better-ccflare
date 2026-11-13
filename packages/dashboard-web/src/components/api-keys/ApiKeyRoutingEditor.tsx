import { COMBO_FLOW_FAMILIES } from "@better-ccflare/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";
import { useCombos, useFamilies } from "../../hooks/queries";
import { queryKeys } from "../../lib/query-keys";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

export function ApiKeyRoutingEditor({
	keyId,
	overrides,
}: {
	keyId: string;
	overrides: Record<string, string> | null;
}) {
	const queryClient = useQueryClient();
	const { data, error } = useCombos();
	const { data: assignments } = useFamilies();
	const [draft, setDraft] = useState(overrides ?? {});
	const save = useMutation({
		mutationFn: () =>
			api.patch(`/api/api-keys/${encodeURIComponent(keyId)}/routing`, {
				familyComboOverrides: Object.keys(draft).length ? draft : null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
			queryClient.invalidateQueries({
				queryKey: [...queryKeys.all, "api-key-usage"],
			});
		},
	});
	return (
		<div className="space-y-4">
			<p className="text-xs text-muted-foreground">
				Choose a combo for each model family. Restrictions and spend limits
				still apply to this key.
			</p>
			{COMBO_FLOW_FAMILIES.map((family) => {
				const globalId = assignments?.families.find(
					(entry) => entry.family === family,
				)?.combo_id;
				const globalName = data?.combos.find(
					(combo) => combo.id === globalId,
				)?.name;
				return (
					<div
						key={family}
						className="grid grid-cols-[5rem_1fr] gap-3 items-center"
					>
						<Label htmlFor={`routing-${keyId}-${family}`}>{family}</Label>
						<Select
							value={draft[family] ?? "__global__"}
							disabled={save.isPending || !data}
							onValueChange={(combo) => {
								setDraft((current) => {
									const next = { ...current };
									if (combo === "__global__") delete next[family];
									else next[family] = combo;
									return next;
								});
								save.reset();
							}}
						>
							<SelectTrigger id={`routing-${keyId}-${family}`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="__global__">
									Global assignment{globalName ? ` (${globalName})` : ""}
								</SelectItem>
								{draft[family] &&
								!data?.combos.some((combo) => combo.id === draft[family]) ? (
									<SelectItem value={draft[family]}>
										Missing combo ({draft[family]})
									</SelectItem>
								) : null}
								{data?.combos.map((combo) => (
									<SelectItem key={combo.id} value={combo.id}>
										{combo.name}
										{combo.enabled ? "" : " (disabled)"}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				);
			})}
			<Button disabled={save.isPending || !data} onClick={() => save.mutate()}>
				{save.isPending ? "Saving..." : "Save routing"}
			</Button>
			{error || save.isError ? (
				<p role="alert" className="text-sm text-destructive">
					{(error ?? save.error) instanceof Error
						? (error ?? save.error)?.message
						: "Failed to load or save routing."}
				</p>
			) : null}
			{save.isSuccess ? (
				<p role="status" className="text-sm text-muted-foreground">
					Routing saved.
				</p>
			) : null}
		</div>
	);
}
