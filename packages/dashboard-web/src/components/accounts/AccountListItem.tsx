import { AccountPresenter } from "@better-ccflare/ui-common";
import {
	AlertCircle,
	Edit2,
	Globe,
	Hash,
	KeyRound,
	Pause,
	Play,
	RefreshCw,
	Trash2,
	Zap,
} from "lucide-react";
import { useState } from "react";
import type { Account } from "../../api";
import {
	providerShowsCreditsBalance,
	providerShowsWeeklyUsage,
	providerSupportsAutoFeatures,
	providerSupportsCustomBilling,
} from "../../utils/provider-utils";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { RateLimitProgress } from "./RateLimitProgress";

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

interface AccountListItemProps {
	account: Account;
	isActive?: boolean;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<void>;
	onRemove: (name: string) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onAutoRefreshToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
}

export function AccountListItem({
	account,
	isActive = false,
	onPauseToggle,
	onForceResetRateLimit,
	onRefreshUsage,
	onRemove,
	onRename,
	onPriorityChange,
	onAutoFallbackToggle,
	onAutoRefreshToggle,
	onBillingTypeToggle,
	onAutoPauseOnOverageToggle,
	onPeakHoursPauseToggle,
	onCustomEndpointChange,
	onModelMappingsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
}: AccountListItemProps) {
	const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
	const presenter = new AccountPresenter(account);
	// Only hard-limit statuses mean the account is actually blocked; soft warnings
	// like "allowed_warning" / "queueing_soft" mean the account is still usable.
	const HARD_LIMIT_PREFIXES = [
		"rate_limited",
		"blocked",
		"queueing_hard",
		"payment_required",
	];
	const isHardLimited = HARD_LIMIT_PREFIXES.some((prefix) =>
		presenter.rateLimitStatus.toLowerCase().startsWith(prefix),
	);
	// Also show Force Reset when rate_limited_until is in the future even if
	// rate_limit_status is soft/OK — the selector still skips the account.
	const isBlockedByLegacyLock =
		typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil > Date.now();
	const showForceReset =
		(isHardLimited || isBlockedByLegacyLock) && !presenter.isPaused;
	// staleLockDetected only fires when numeric usage data exists (Anthropic accounts);
	// Zai/NanoGPT accounts have usageUtilization === null and are correctly excluded
	const staleLockDetected =
		showForceReset &&
		typeof account.usageUtilization === "number" &&
		account.usageUtilization < 100;
	const isUsageThrottled =
		typeof account.usageThrottledUntil === "number" &&
		account.usageThrottledUntil > Date.now();

	// Parse Bedrock profile and region from custom_endpoint
	let bedrockProfile: string | null = null;
	let bedrockRegion: string | null = null;
	let bedrockCrossRegionMode: string | null = null;
	if (account.provider === "bedrock" && account.customEndpoint) {
		const match = account.customEndpoint.match(/^bedrock:([^:]+):(.+)$/);
		if (match) {
			bedrockProfile = match[1];
			bedrockRegion = match[2];
		}
		bedrockCrossRegionMode = account.crossRegionMode || "geographic";
	}

	return (
		<div
			key={account.name}
			className={`p-4 border rounded-lg transition-colors space-y-4 ${
				isActive
					? "border-primary bg-primary/5 shadow-sm"
					: "border-border hover:border-muted-foreground/50"
			}`}
		>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<div>
						<div className="flex items-center gap-2">
							<p className="font-medium">{account.name}</p>
							{isActive && (
								<span className="px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
									Active
								</span>
							)}
							<span className="px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground rounded-full">
								Priority: {account.priority}
							</span>
							<OAuthTokenStatusWithBoundary
								accountName={account.name}
								hasRefreshToken={account.hasRefreshToken}
							/>
							{providerSupportsAutoFeatures(account.provider) && (
								<>
									<div className="flex items-center gap-2">
										<span className="text-xs text-muted-foreground">
											Auto-fallback:
										</span>
										<Switch
											checked={account.autoFallbackEnabled}
											onCheckedChange={() => onAutoFallbackToggle(account)}
											title="Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities."
										/>
									</div>
									<div className="flex items-center gap-2">
										<span className="text-xs text-muted-foreground">
											Auto-refresh:
										</span>
										<Switch
											checked={account.autoRefreshEnabled}
											onCheckedChange={() => onAutoRefreshToggle(account)}
											title="Automatically sends a minimal message when the usage window resets to avoid cold-start latency. Does not affect OAuth token refreshing."
										/>
									</div>
								</>
							)}
							{providerSupportsCustomBilling(account.provider) && (
								<div className="flex items-center gap-2">
									<span className="text-xs text-muted-foreground">
										Plan billing:
									</span>
									<Switch
										checked={account.billingType === "plan"}
										onCheckedChange={() => onBillingTypeToggle(account)}
										title="Toggle plan billing for this account"
									/>
								</div>
							)}
							{account.provider === "anthropic" &&
								onAutoPauseOnOverageToggle && (
									<div className="flex items-center gap-2">
										<span className="text-xs text-muted-foreground">
											Auto-pause on overage:
										</span>
										<Switch
											checked={account.autoPauseOnOverageEnabled ?? false}
											onCheckedChange={() =>
												onAutoPauseOnOverageToggle(account)
											}
											title="Automatically pause account when overage usage is detected. Note: detection only happens when Anthropic API reports overage, so some overage usage may occur before pausing. Account resumes when usage window resets."
										/>
									</div>
								)}
							{account.provider === "zai" && onPeakHoursPauseToggle && (
								<div className="flex items-center gap-2">
									<span className="text-xs text-muted-foreground">
										Peak hours pause:
									</span>
									<Switch
										checked={account.peakHoursPauseEnabled ?? false}
										onCheckedChange={() => onPeakHoursPauseToggle(account)}
										title="Automatically pause this account during Zai peak hours (14:00–18:00 SGT)"
									/>
								</div>
							)}
						</div>
						<div className="flex items-center gap-2">
							<p className="text-sm text-muted-foreground">
								{account.provider}
							</p>
							{account.provider === "bedrock" && bedrockProfile && (
								<>
									<span className="text-sm text-muted-foreground">•</span>
									<p className="text-sm text-muted-foreground">
										Profile: {bedrockProfile}
									</p>
									{bedrockRegion && (
										<>
											<span className="text-sm text-muted-foreground">•</span>
											<div
												className="flex items-center gap-1"
												title={`Region: ${bedrockRegion}`}
											>
												<Globe className="h-3 w-3 text-muted-foreground" />
												<p className="text-sm text-muted-foreground">
													{bedrockRegion}
												</p>
											</div>
										</>
									)}
									{bedrockCrossRegionMode && (
										<>
											<span className="text-sm text-muted-foreground">•</span>
											<p
												className="text-sm text-muted-foreground"
												title="Cross-region inference mode"
											>
												{bedrockCrossRegionMode}
											</p>
										</>
									)}
								</>
							)}
						</div>
					</div>
					<div className="flex items-center gap-2">
						{presenter.isRateLimited && (
							<span title="Account is rate-limited - requests will be rejected until the limit resets">
								<AlertCircle className="h-4 w-4 text-yellow-600" />
							</span>
						)}
						<span className="text-sm">{presenter.requestCount} requests</span>
						<span className="text-sm text-muted-foreground">
							{presenter.sessionInfo}
						</span>
						{presenter.isPaused && (
							<span className="text-sm text-muted-foreground">Paused</span>
						)}
						{!presenter.isPaused && presenter.rateLimitStatus !== "OK" && (
							<span
								className={`text-sm ${
									presenter.rateLimitStatus
										.toLowerCase()
										.startsWith("allowed_warning")
										? "text-amber-600"
										: presenter.rateLimitStatus
													.toLowerCase()
													.startsWith("allowed")
											? "text-green-600"
											: "text-destructive"
								}`}
							>
								{presenter.rateLimitStatus}
							</span>
						)}
						{staleLockDetected && (
							<span
								className="text-sm text-amber-600"
								title="Stale lock detected: usage data shows available capacity but account is still rate-limited"
							>
								Stale lock detected
							</span>
						)}
						{isUsageThrottled && (
							<span
								className="text-sm text-amber-600"
								title="Usage throttling is delaying requests for this account until pacing catches up"
							>
								Usage throttled
							</span>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onRename(account)}
						title="Rename account"
					>
						<Edit2 className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onPriorityChange(account)}
						title="Change account priority"
					>
						<Zap className="h-4 w-4" />
					</Button>
					{onCustomEndpointChange && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onCustomEndpointChange(account)}
							title={
								account.customEndpoint
									? `Custom endpoint: ${account.customEndpoint}`
									: "Set custom endpoint"
							}
						>
							<Globe
								className={`h-4 w-4 ${
									account.customEndpoint ? "text-primary" : ""
								}`}
							/>
						</Button>
					)}
					{onModelMappingsChange && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onModelMappingsChange(account)}
							title={
								account.modelMappings
									? `Model mappings configured (${Object.keys(account.modelMappings).length} mappings)`
									: "Configure model mappings"
							}
						>
							<Hash
								className={`h-4 w-4 ${
									account.modelMappings ? "text-primary" : ""
								}`}
							/>
						</Button>
					)}
					{account.provider === "qwen" && onReauth && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onReauth(account)}
							title="Re-authenticate this Qwen account (preserves all metadata)"
						>
							<KeyRound className="h-4 w-4" />
						</Button>
					)}
					{account.provider === "anthropic" &&
						account.hasRefreshToken &&
						onAnthropicReauth && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => onAnthropicReauth(account)}
								title="Re-authenticate this Anthropic account (preserves all metadata)"
							>
								<KeyRound className="h-4 w-4" />
							</Button>
						)}
					{account.provider === "codex" && onCodexReauth && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onCodexReauth(account)}
							title="Re-authenticate this Codex account (preserves all metadata)"
						>
							<KeyRound className="h-4 w-4" />
						</Button>
					)}
					{(account.provider === "anthropic" ||
						account.provider === "codex") && (
						<Button
							variant="ghost"
							size="sm"
							className="h-8 gap-1 text-xs"
							disabled={isRefreshingUsage}
							onClick={async () => {
								setIsRefreshingUsage(true);
								try {
									await onRefreshUsage(account);
								} finally {
									setIsRefreshingUsage(false);
								}
							}}
							title={
								account.provider === "codex"
									? "Refresh usage data (sends one minimal Codex request — consumes a small slice of quota)"
									: "Refresh usage data (restarts usage polling and refreshes token if expired)"
							}
						>
							<RefreshCw
								className={`h-3.5 w-3.5 ${isRefreshingUsage ? "animate-spin" : ""}`}
							/>
						</Button>
					)}
					{showForceReset && (
						<Button
							variant="outline"
							size="sm"
							className="h-8 gap-1 text-xs"
							onClick={() => onForceResetRateLimit(account)}
							title={
								staleLockDetected
									? "Reset stale rate limit lock (usage shows capacity available)"
									: "Force clear rate limit state from database"
							}
						>
							<RefreshCw className="h-3.5 w-3.5" />
							Force Reset
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onPauseToggle(account)}
						title={account.paused ? "Resume account" : "Pause account"}
					>
						{account.paused ? (
							<Play className="h-4 w-4" />
						) : (
							<Pause className="h-4 w-4" />
						)}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onRemove(account.name)}
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			</div>
			{account.sessionStats && (
				<div className="text-xs text-muted-foreground">
					Session: {account.sessionStats.requests} req
					{" · "}↑{formatTokenCount(account.sessionStats.inputTokens)} in
					{" · "}✦
					{formatTokenCount(account.sessionStats.cacheCreationInputTokens)}{" "}
					cache↑
					{" · "}✦{formatTokenCount(account.sessionStats.cacheReadInputTokens)}{" "}
					cache↓
					{" · "}↓{formatTokenCount(account.sessionStats.outputTokens)} out
					{account.sessionStats.planCostUsd > 0 && (
						<>
							{" · "}${account.sessionStats.planCostUsd.toFixed(2)} plan
						</>
					)}
					{account.sessionStats.apiCostUsd > 0 && (
						<>
							{" · "}${account.sessionStats.apiCostUsd.toFixed(2)} api
						</>
					)}
				</div>
			)}
			{(account.rateLimitReset ||
				account.usageData ||
				account.usageRateLimitedUntil ||
				providerShowsCreditsBalance(account.provider)) && (
				<RateLimitProgress
					resetIso={account.rateLimitReset}
					usageUtilization={account.usageUtilization}
					usageWindow={account.usageWindow}
					usageData={account.usageData}
					usageRateLimitedUntil={account.usageRateLimitedUntil}
					usageThrottledUntil={account.usageThrottledUntil}
					usageThrottledWindows={account.usageThrottledWindows}
					provider={account.provider}
					showWeekly={providerShowsWeeklyUsage(account.provider)}
				/>
			)}
		</div>
	);
}
