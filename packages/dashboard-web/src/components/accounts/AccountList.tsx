import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";

interface AccountListProps {
	accounts: Account[] | undefined;
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

export function AccountList({
	accounts,
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
}: AccountListProps) {
	if (!accounts || accounts.length === 0) {
		return <p className="text-muted-foreground">No accounts configured</p>;
	}

	return (
		<div className="space-y-2">
			{accounts.map((account) => (
				<AccountListItem
					key={account.name}
					account={account}
					isPrimary={account.isPrimary}
					onPauseToggle={onPauseToggle}
					onForceResetRateLimit={onForceResetRateLimit}
					onRefreshUsage={onRefreshUsage}
					onRemove={onRemove}
					onRename={onRename}
					onPriorityChange={onPriorityChange}
					onAutoFallbackToggle={onAutoFallbackToggle}
					onAutoRefreshToggle={onAutoRefreshToggle}
					onBillingTypeToggle={onBillingTypeToggle}
					onAutoPauseOnOverageToggle={onAutoPauseOnOverageToggle}
					onPeakHoursPauseToggle={onPeakHoursPauseToggle}
					onCustomEndpointChange={onCustomEndpointChange}
					onModelMappingsChange={onModelMappingsChange}
					onReauth={onReauth}
					onAnthropicReauth={onAnthropicReauth}
					onCodexReauth={onCodexReauth}
				/>
			))}
		</div>
	);
}
