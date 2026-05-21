import { useEffect, useState } from "react";
import {
	useCleanupNow,
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
				</div>

				{cleanupNow.isError && (
					<p className="text-xs text-destructive">
						Operation timed out — for large databases this may take several
						minutes. Check server logs.
					</p>
				)}

				{cleanupNow.data && (
					<div className="text-xs text-muted-foreground space-y-1">
						<p>
							Removed {cleanupNow.data.removedPayloads} payloads (
							{cleanupNow.data.payloadCutoffIso ? (
								<>
									older than{" "}
									{new Date(cleanupNow.data.payloadCutoffIso).toLocaleString()}
								</>
							) : (
								<>all — storage disabled</>
							)}
							) and {cleanupNow.data.removedRequests} requests (older than{" "}
							{new Date(cleanupNow.data.requestCutoffIso).toLocaleString()}).
						</p>
						{(cleanupNow.data.dbSizeBytes > 0 ||
							cleanupNow.data.tableRowCounts.length > 0) && (
							<details>
								<summary className="cursor-pointer select-none">
									Space usage
									{cleanupNow.data.dbSizeBytes > 0 && (
										<>
											{" "}
											— {(cleanupNow.data.dbSizeBytes / 1024 / 1024).toFixed(1)}{" "}
											MB on disk
										</>
									)}
								</summary>
								{cleanupNow.data.tableRowCounts.length > 0 && (
									<table className="mt-1 w-full text-left">
										<tbody>
											{cleanupNow.data.tableRowCounts.map((row) => (
												<tr key={row.name}>
													<td className="pr-4 font-mono">{row.name}</td>
													<td className="text-right">
														{row.dataBytes !== undefined
															? `${(row.dataBytes / 1024 / 1024).toFixed(1)} MB`
															: `${row.rowCount.toLocaleString()} rows`}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								)}
							</details>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
