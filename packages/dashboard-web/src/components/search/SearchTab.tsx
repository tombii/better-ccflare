import { Plus } from "lucide-react";
import { useState } from "react";
import { useApiError } from "../../hooks/useApiError";
import {
	useSearchProviderCatalog,
	useSearchProviders,
} from "../../hooks/useSearchProviders";
import type { SearchProviderPublic } from "../../lib/search-provider-types";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { ProviderDialog } from "./ProviderDialog";
import { SearchProviderRow } from "./SearchProviderRow";
import { WebSearchSettingsCard } from "./WebSearchSettingsCard";

/**
 * The /search page: the master web-search settings on top, the list of
 * configured providers below. Without at least one enabled provider the
 * master toggle has nothing to route to, and the empty state says so.
 */
export function SearchTab() {
	const providersQuery = useSearchProviders();
	const catalogQuery = useSearchProviderCatalog();
	const { formatError } = useApiError();
	const [isAddOpen, setIsAddOpen] = useState(false);
	const [editProvider, setEditProvider] = useState<SearchProviderPublic | null>(
		null,
	);

	const providers = providersQuery.data ?? [];
	const catalog = catalogQuery.data ?? [];
	const catalogLabel = (id: string) =>
		catalog.find((entry) => entry.id === id)?.label;

	return (
		<div className="space-y-6">
			<WebSearchSettingsCard />

			<Separator />

			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-lg font-semibold">Search providers</h2>
						<p className="text-sm text-muted-foreground">
							Tried in priority order; the next one is used when an earlier one
							fails or is cooling down.
						</p>
					</div>
					<Button onClick={() => setIsAddOpen(true)}>
						<Plus className="mr-2 h-4 w-4" />
						Add provider
					</Button>
				</div>

				{providersQuery.isLoading && (
					<p className="text-sm text-muted-foreground">Loading providers...</p>
				)}

				{providersQuery.isError && (
					<p className="text-sm text-destructive">
						Failed to load search providers: {formatError(providersQuery.error)}
						. The server may be running a version without the web-search API.
					</p>
				)}

				{!providersQuery.isLoading &&
					!providersQuery.isError &&
					providers.length === 0 && (
						<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-8 py-12 text-center">
							<p className="text-sm text-muted-foreground">
								No search providers yet. Until you add one, enabling web-search
								interception does nothing — search requests are passed through
								to the upstream provider untouched.
							</p>
							<Button size="sm" onClick={() => setIsAddOpen(true)}>
								<Plus className="mr-2 h-4 w-4" />
								Add provider
							</Button>
						</div>
					)}

				{providers.length > 0 && (
					<div className="space-y-3">
						{providers.map((provider) => (
							<SearchProviderRow
								key={provider.id}
								provider={provider}
								catalogLabel={catalogLabel(provider.provider)}
								onEdit={() => setEditProvider(provider)}
							/>
						))}
					</div>
				)}
			</div>

			{isAddOpen && (
				<ProviderDialog isOpen onClose={() => setIsAddOpen(false)} />
			)}
			{editProvider && (
				<ProviderDialog
					isOpen
					provider={editProvider}
					onClose={() => setEditProvider(null)}
				/>
			)}
		</div>
	);
}
