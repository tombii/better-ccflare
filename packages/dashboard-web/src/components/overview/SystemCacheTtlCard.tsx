import { useSetSystemCacheTtl, useSystemCacheTtl } from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

export function SystemCacheTtlCard() {
	const { data, isLoading } = useSystemCacheTtl();
	const setTtl = useSetSystemCacheTtl();

	const enabled = data?.system_prompt_cache_ttl_1h ?? false;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>System Prompt Cache TTL</CardTitle>
				<CardDescription>
					Inject 1h TTL into system prompt cache_control blocks. Reduces
					keepalive frequency needed for system prompts. Only applies to
					Anthropic-compatible providers.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-3">
					<Switch
						disabled={isLoading || setTtl.isPending}
						checked={enabled}
						onCheckedChange={(checked) => setTtl.mutate(checked)}
					/>
					<span className="text-sm text-muted-foreground">
						{enabled ? "Enabled" : "Disabled"}
					</span>
				</div>
			</CardContent>
		</Card>
	);
}
