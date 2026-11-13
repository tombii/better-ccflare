import type { ApiKeyResponse } from "@better-ccflare/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "../../lib/query-keys";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { applyApiKeySpendReset, resetSpendConfirmation } from "./reset-spend";

export type ResetSpendKey = Pick<ApiKeyResponse, "id" | "name" | "limits">;

export function ApiKeyResetSpendDialog({
	apiKey,
	onClose,
}: {
	apiKey: ResetSpendKey | null;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const reset = useMutation({
		mutationFn: async () => {
			if (!apiKey) throw new Error("Select an API key");
			await Promise.all([
				queryClient.cancelQueries({ queryKey: queryKeys.apiKeys() }),
				queryClient.cancelQueries({
					queryKey: [...queryKeys.all, "api-key-usage"],
				}),
			]);
			return api.post<{ success: boolean; data: ApiKeyResponse }>(
				`/api/api-keys/${encodeURIComponent(apiKey.id)}/reset-spend`,
			);
		},
		onSuccess: (response) => {
			applyApiKeySpendReset(queryClient, response.data);
			queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
			queryClient.invalidateQueries({
				queryKey: [...queryKeys.all, "api-key-usage"],
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.insightsAlerts() });
			onClose();
		},
	});
	return (
		<Dialog
			open={apiKey !== null}
			onOpenChange={(open) => {
				if (!open && !reset.isPending) {
					reset.reset();
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Reset spend</DialogTitle>
					<DialogDescription>
						{resetSpendConfirmation(apiKey?.name ?? "")}
					</DialogDescription>
				</DialogHeader>
				{reset.isError ? (
					<p role="alert" className="text-sm text-destructive">
						{reset.error.message}
					</p>
				) : null}
				<DialogFooter>
					<Button
						variant="outline"
						disabled={reset.isPending}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						disabled={reset.isPending || !apiKey?.limits?.length}
						onClick={() => reset.mutate()}
					>
						{reset.isPending ? "Resetting…" : "Reset spend"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
