import { AccountPresenter } from "@better-ccflare/ui-common";
import {
	AlertCircle,
	Edit2,
	Globe,
	Hash,
	Pause,
	Play,
	RefreshCw,
	Trash2,
	Zap,
} from "lucide-react";
import type { Account } from "../../api";
import {
	providerShowsWeeklyUsage,
	providerSupportsAutoFeatures,
	providerSupportsModelMappings,
} from "../../utils/provider-utils";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { RateLimitProgress } from "./RateLimitProgress";

interface AccountListItemProps {
	account: Account;
	isActive?: boolean;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRemove: (name: string) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onAutoRefreshToggle: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
}

export function AccountListItem({
	account,
	isActive = false,
	onPauseToggle,
	onForceResetRateLimit,
	onRemove,
	onRename,
	onPriorityChange,
	onAutoFallbackToggle,
	onAutoRefreshToggle,
	onCustomEndpointChange,
	onModelMappingsChange,
}: AccountListItemProps) {
	const presenter = new AccountPresenter(account);
	const showForceReset =
		presenter.rateLimitStatus !== "OK" && !presenter.isPaused;
	// staleLockDetected only fires when numeric usage data exists (Anthropic accounts);
	// Zai/NanoGPT accounts have usageUtilization === null and are correctly excluded
	const staleLockDetected =
		showForceReset &&
		typeof account.usageUtilization === "number" &&
		account.usageUtilization < 100;

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
											title="Toggle auto-fallback for this account"
										/>
									</div>
									<div className="flex items-center gap-2">
										<span className="text-xs text-muted-foreground">
											Auto-refresh:
										</span>
										<Switch
											checked={account.autoRefreshEnabled}
											onCheckedChange={() => onAutoRefreshToggle(account)}
											title="Toggle auto-refresh for this account"
										/>
									</div>
								</>
							)}
						</div>
						<p className="text-sm text-muted-foreground">{account.provider}</p>
					</div>
					<div className="flex items-center gap-2">
						{presenter.isRateLimited && (
							<span title="Account is rate-limited - requests will be rejected until the limit resets">
								<AlertCircle className="h-4 w-4 text-yellow-600" />
							</span>
						)}
						<span className="text-sm">{presenter.requestCount} requests</span>
						{presenter.isPaused && (
							<span className="text-sm text-muted-foreground">Paused</span>
						)}
						{!presenter.isPaused && presenter.rateLimitStatus !== "OK" && (
							<span className="text-sm text-destructive">
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
					{onModelMappingsChange &&
						providerSupportsModelMappings(account.provider) && (
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
			{(account.rateLimitReset ||
				providerShowsWeeklyUsage(account.provider)) && (
				<RateLimitProgress
					resetIso={account.rateLimitReset}
					usageUtilization={account.usageUtilization}
					usageWindow={account.usageWindow}
					usageData={account.usageData}
					provider={account.provider}
					showWeekly={providerShowsWeeklyUsage(account.provider)}
				/>
			)}
		</div>
	);
}
