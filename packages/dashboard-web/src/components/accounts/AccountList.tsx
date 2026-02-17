import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";

interface AccountListProps {
	accounts: Account[] | undefined;
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

export function AccountList({
	accounts,
	onPauseToggle,
	onForceResetRateLimit,
	onRemove,
	onRename,
	onPriorityChange,
	onAutoFallbackToggle,
	onAutoRefreshToggle,
	onCustomEndpointChange,
	onModelMappingsChange,
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
					onRemove={onRemove}
					onRename={onRename}
					onPriorityChange={onPriorityChange}
					onAutoFallbackToggle={onAutoFallbackToggle}
					onAutoRefreshToggle={onAutoRefreshToggle}
					onCustomEndpointChange={onCustomEndpointChange}
					onModelMappingsChange={onModelMappingsChange}
				/>
			))}
		</div>
	);
}
