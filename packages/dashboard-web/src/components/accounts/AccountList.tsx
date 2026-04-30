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
	onCustomEndpointChange,
	onModelMappingsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
}: AccountListProps) {
	if (!accounts || accounts.length === 0) {
		return <p className="text-muted-foreground">No accounts configured</p>;
	}

	// Find the most recently used account
	const mostRecentAccountId = accounts.reduce(
		(mostRecent, account) => {
			if (!account.lastUsed) return mostRecent;
			if (!mostRecent) return account.id;

			const mostRecentAccount = accounts.find((a) => a.id === mostRecent);
			if (!mostRecentAccount?.lastUsed) return account.id;

			const mostRecentLastUsed = new Date(mostRecentAccount.lastUsed).getTime();
			const currentLastUsed = new Date(account.lastUsed).getTime();

			return currentLastUsed > mostRecentLastUsed ? account.id : mostRecent;
		},
		null as string | null,
	);

	return (
		<div className="space-y-2">
			{accounts.map((account) => (
				<AccountListItem
					key={account.name}
					account={account}
					isActive={account.id === mostRecentAccountId}
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
