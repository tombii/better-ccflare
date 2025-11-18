import { AlertTriangle, CheckCircle, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

type TokenHealthStatus =
	| "healthy"
	| "warning"
	| "critical"
	| "expired"
	| "no-refresh-token"
	| "loading";

interface TokenHealthIndicatorProps {
	accountName?: string;
	showDetails?: boolean;
	className?: string;
}

interface TokenHealthData {
	status: TokenHealthStatus;
	message: string;
	daysUntilExpiration?: number;
	requiresReauth: boolean;
}

export function TokenHealthIndicator({
	accountName,
	showDetails = false,
	className = "",
}: TokenHealthIndicatorProps) {
	const [tokenHealth, setTokenHealth] = useState<TokenHealthData | null>(null);
	const [loading, setLoading] = useState(true);

	const loadTokenHealth = useCallback(async () => {
		setLoading(true);
		try {
			if (accountName) {
				const response = await api.getAccountTokenHealth(accountName);
				if (response.success) {
					setTokenHealth(response.data);
				}
			} else {
				const response = await api.getTokenHealth();
				if (response.success) {
					// Get the worst status from all accounts
					const accounts = response.data.accounts;
					const worstAccount =
						accounts.find(
							(acc: any) =>
								acc.status === "expired" || acc.status === "critical",
						) ||
						accounts.find((acc: any) => acc.status === "warning") ||
						accounts[0];

					setTokenHealth(worstAccount);
				}
			}
		} catch (error) {
			console.error("Failed to load token health:", error);
		} finally {
			setLoading(false);
		}
	}, [accountName]);

	const getStatusIcon = (status: TokenHealthStatus) => {
		switch (status) {
			case "healthy":
				return <CheckCircle className="h-4 w-4 text-green-500" />;
			case "warning":
				return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
			case "critical":
			case "expired":
				return <XCircle className="h-4 w-4 text-red-500" />;
			case "no-refresh-token":
				return <CheckCircle className="h-4 w-4 text-blue-500" />;
			case "loading":
				return <RefreshCw className="h-4 w-4 text-gray-400 animate-spin" />;
			default:
				return <CheckCircle className="h-4 w-4 text-gray-400" />;
		}
	};

	const getStatusColor = (status: TokenHealthStatus) => {
		switch (status) {
			case "healthy":
				return "text-green-600 bg-green-50 border-green-200";
			case "warning":
				return "text-yellow-600 bg-yellow-50 border-yellow-200";
			case "critical":
			case "expired":
				return "text-red-600 bg-red-50 border-red-200";
			case "no-refresh-token":
				return "text-blue-600 bg-blue-50 border-blue-200";
			case "loading":
				return "text-gray-600 bg-gray-50 border-gray-200";
			default:
				return "text-gray-600 bg-gray-50 border-gray-200";
		}
	};

	const getStatusText = (status: TokenHealthStatus) => {
		switch (status) {
			case "healthy":
				return "Healthy";
			case "warning":
				return "Warning";
			case "critical":
				return "Critical";
			case "expired":
				return "Expired";
			case "no-refresh-token":
				return "API Key";
			case "loading":
				return "Loading...";
			default:
				return "Unknown";
		}
	};

	if (loading || !tokenHealth) {
		return (
			<div
				className={`flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium ${className}`}
			>
				<RefreshCw className="h-4 w-4 text-gray-400 animate-spin" />
				<span className="text-gray-600">Loading...</span>
			</div>
		);
	}

	return (
		<div
			className={`flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium ${getStatusColor(tokenHealth.status)} ${className}`}
		>
			{getStatusIcon(tokenHealth.status)}
			<span>{getStatusText(tokenHealth.status)}</span>

			{showDetails && (
				<div className="ml-2 text-xs max-w-xs">
					<div className="font-medium">{tokenHealth.message}</div>
					{tokenHealth.daysUntilExpiration !== undefined && (
						<div className="mt-1">
							Expires in {tokenHealth.daysUntilExpiration} days
						</div>
					)}
					{tokenHealth.requiresReauth && (
						<div className="mt-2">
							<button
								type="button"
								onClick={() => {
									// Could open a reauth modal or show instructions
									console.log(
										`Re-authenticate account: ${accountName || "accounts"}`,
									);
								}}
								className="text-xs bg-white bg-opacity-50 px-2 py-1 rounded border border-current"
							>
								Re-authenticate
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
