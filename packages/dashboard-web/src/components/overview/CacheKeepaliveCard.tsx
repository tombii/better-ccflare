import { useKeepaliveTtl, useSetKeepaliveTtl } from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

const TTL_OPTIONS = [
	{ label: "Disabled", value: 0 },
	{ label: "5 minutes", value: 5 },
	{ label: "10 minutes", value: 10 },
	{ label: "30 minutes", value: 30 },
	{ label: "1 hour", value: 60 },
];

export function CacheKeepaliveCard() {
	const { data, isLoading } = useKeepaliveTtl();
	const setTtl = useSetKeepaliveTtl();

	const currentValue = data?.ttlMinutes ?? 0;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Cache Keep-Alive</CardTitle>
				<CardDescription>
					Periodically send a background request to refresh Anthropic prompt
					cache before it expires. Helps maintain cache across longer pauses in
					work.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Select
					disabled={isLoading || setTtl.isPending}
					value={String(currentValue)}
					onValueChange={(v) => setTtl.mutate({ ttlMinutes: parseInt(v, 10) })}
				>
					<SelectTrigger className="w-48">
						<SelectValue placeholder="Select TTL..." />
					</SelectTrigger>
					<SelectContent>
						{TTL_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={String(opt.value)}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{currentValue > 0 && (
					<p className="text-xs text-muted-foreground mt-2">
						Keepalive runs every {currentValue - 1} minute
						{currentValue - 1 !== 1 ? "s" : ""}, refreshing cached prompts for
						accounts that used caching recently.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
