import { useEffect, useState } from "react";
import {
	useCleanupNow,
	useCompactDb,
	useRetention,
	useSetRetention,
} from "../../hooks/queries";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

export function DataRetentionCard() {
	const { data, isLoading } = useRetention();
	const setRetention = useSetRetention();
	const cleanupNow = useCleanupNow();
	const compactDb = useCompactDb();
	const [payloadDays, setPayloadDays] = useState<number>(
		data?.payloadDays ?? 3,
	);
	const [requestDays, setRequestDays] = useState<number>(
		data?.requestDays ?? 90,
	);

	useEffect(() => {
		if (typeof data?.payloadDays === "number") setPayloadDays(data.payloadDays);
		if (typeof data?.requestDays === "number") setRequestDays(data.requestDays);
	}, [data?.payloadDays, data?.requestDays]);

	const disabled = isLoading || setRetention.isPending;
	const validPayload =
		Number.isFinite(payloadDays) && payloadDays >= 1 && payloadDays <= 365;
	const validRequests =
		Number.isFinite(requestDays) && requestDays >= 1 && requestDays <= 3650;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Payload Retention</CardTitle>
				<CardDescription>
					Automatically delete request/response payloads older than this window.
					Analytics remain intact.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex items-center gap-2">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium w-28">Payloads</span>
						<Input
							type="number"
							min={1}
							max={365}
							value={payloadDays}
							onChange={(e) =>
								setPayloadDays(parseInt(e.target.value || "0", 10))
							}
							className="w-24"
						/>
						<span className="text-sm text-muted-foreground">days</span>
					</div>
					<Button
						size="sm"
						disabled={disabled || !validPayload}
						onClick={() => setRetention.mutate({ payloadDays })}
					>
						Save
					</Button>
				</div>

				<div className="flex items-center gap-2 pt-2">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium w-28">Requests</span>
						<Input
							type="number"
							min={1}
							max={3650}
							value={requestDays}
							onChange={(e) =>
								setRequestDays(parseInt(e.target.value || "0", 10))
							}
							className="w-24"
						/>
						<span className="text-sm text-muted-foreground">days</span>
					</div>
					<Button
						size="sm"
						disabled={disabled || !validRequests}
						onClick={() => setRetention.mutate({ requestDays })}
					>
						Save
					</Button>
				</div>

				<div className="flex items-center justify-between pt-2 pb-1">
					<div>
						<p className="text-sm font-medium">Store message payloads</p>
						<p className="text-xs text-muted-foreground">
							Stores full request/response bodies (conversation text, images) in
							the database. Disable to reduce database size and lower memory
							pressure — token counts, costs, and analytics are always saved
							regardless.
						</p>
						<p className="text-xs text-amber-500 mt-0.5">
							Warning: storing payloads can significantly grow the database size
							over time.
						</p>
					</div>
					<Switch
						checked={data?.storePayloads ?? true}
						disabled={isLoading || setRetention.isPending}
						onCheckedChange={(checked) =>
							setRetention.mutate({ storePayloads: checked })
						}
					/>
				</div>

				<div className="pt-1 flex items-center gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => cleanupNow.mutate()}
						disabled={cleanupNow.isPending}
					>
						{cleanupNow.isPending ? "Cleaning up…" : "Clean up now"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => compactDb.mutate()}
						disabled={compactDb.isPending}
					>
						{compactDb.isPending ? "Compacting…" : "Compact database"}
					</Button>
				</div>

				{cleanupNow.data && (
					<p className="text-xs text-muted-foreground">
						Removed {cleanupNow.data.removedPayloads} payloads (older than{" "}
						{new Date(cleanupNow.data.payloadCutoffIso).toLocaleString()}) and{" "}
						{cleanupNow.data.removedRequests} requests (older than{" "}
						{new Date(cleanupNow.data.requestCutoffIso).toLocaleString()}).
					</p>
				)}

				{compactDb.isSuccess && (
					<p className="text-xs text-muted-foreground">
						Database compacted. File size should reduce on disk.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
