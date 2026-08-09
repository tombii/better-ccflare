import {
	AlertTriangle,
	CheckCircle,
	Loader2,
	XCircle,
	Zap,
} from "lucide-react";
import { useState } from "react";
import { useTestAccountModel } from "../../hooks/useProviderModels";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export interface ModelTestButtonProps {
	accountId?: string | null;
	model: string;
	/** The model came from a comma-separated list: indicates which one was tested. */
	fromList?: boolean;
	className?: string;
}

/**
 * Sends ONE real request to the provider with the selected model and shows the
 * raw upstream response. The exact error text is the main value: that was
 * missing in the gpt-5.3-codex incident (the model exists in the OpenAI
 * catalog, but a ChatGPT subscription account received HTTP 400).
 *
 * There are THREE states, not two. A 429/503/529 does not reject the model:
 * it only says the account was unavailable at that moment. Measured in
 * production, the test rejected a model that served real traffic with HTTP
 * 200 in the same minute — so this case becomes a WARNING, with text that
 * does not imply the model is at fault.
 */
export function ModelTestButton({
	accountId,
	model,
	fromList,
	className,
}: ModelTestButtonProps) {
	const [open, setOpen] = useState(false);
	const test = useTestAccountModel();

	const trimmedModel = model.trim();
	const hasAccount = Boolean(accountId);
	const isPending = test.isPending;
	// Without a target account or model there is nothing to test; while a call
	// is in flight, the button is locked to avoid spending quota twice.
	const disabled = !hasAccount || trimmedModel.length === 0 || isPending;

	const hint = !hasAccount
		? "Pick an account first: the test runs with the credentials of that account."
		: trimmedModel.length === 0
			? "Nothing to test: an empty model means the model of the client is forwarded as is."
			: isPending
				? "Test running..."
				: `Sends ONE real request to ${trimmedModel}${fromList ? " (first model of the list)" : ""} with this account. It consumes quota.`;

	const handleTest = () => {
		if (disabled || !accountId) return;
		test.mutate(
			{ accountId, model: trimmedModel },
			{ onSettled: () => setOpen(true) },
		);
	};

	const result = test.data;
	// Third state: the backend marks inconclusive when the response does not
	// allow judging the model (account currently unavailable: 429/503/529).
	const inconclusive = Boolean(result && !result.ok && result.inconclusive);

	return (
		<span title={hint} className={cn("inline-flex shrink-0", className)}>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={disabled}
						title={hint}
						onClick={handleTest}
					>
						{isPending ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Zap className="h-3.5 w-3.5" />
						)}
						Test
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-[26rem] p-3">
					{isPending && (
						<p className="flex items-center gap-2 text-xs text-muted-foreground">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							Calling the provider...
						</p>
					)}

					{!isPending && !result && (
						<p className="text-xs text-muted-foreground">
							No test yet. The button sends one real request with this model and
							shows the raw answer of the provider. It consumes quota.
						</p>
					)}

					{!isPending && result && (
						<div className="space-y-2">
							<div className="flex flex-wrap items-center gap-2">
								{inconclusive ? (
									<AlertTriangle className="h-4 w-4 text-yellow-500" />
								) : result.ok ? (
									<CheckCircle className="h-4 w-4 text-green-600" />
								) : (
									<XCircle className="h-4 w-4 text-destructive" />
								)}
								<span className="text-sm font-medium">
									{inconclusive
										? "Test inconclusive"
										: result.ok
											? "Model accepted"
											: "Model rejected"}
								</span>
								<Badge
									variant={
										inconclusive
											? "warning"
											: result.ok
												? "success"
												: "destructive"
									}
									className="px-1.5 py-0 text-[10px]"
								>
									HTTP {result.status || "no response"}
								</Badge>
								<span className="text-[11px] text-muted-foreground">
									{result.durationMs} ms
								</span>
							</div>

							<p className="break-all font-mono text-[11px] text-muted-foreground">
								{test.variables?.model}
							</p>

							{inconclusive && (
								<p className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-[11px] text-foreground">
									The account is unavailable right now (rate limit or capacity),
									so the test never got to check the model. Nothing here says
									the model is invalid — try again in a few minutes.
								</p>
							)}

							{result.error && (
								<div className="space-y-1">
									<span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
										Raw provider answer
									</span>
									<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px]">
										{result.error}
									</pre>
								</div>
							)}

							{!result.ok && result.status === 400 && (
								<p className="text-[11px] text-muted-foreground">
									HTTP 400 usually means the model exists in the catalog but is
									not released for the plan of this account.
								</p>
							)}
						</div>
					)}
				</PopoverContent>
			</Popover>
		</span>
	);
}
