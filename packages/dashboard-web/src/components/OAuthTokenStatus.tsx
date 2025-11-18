import { AlertTriangle, CheckCircle, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";

interface OAuthTokenStatusProps {
	accountName: string;
	hasRefreshToken: boolean;
	provider: string;
}

type TokenStatus =
	| "healthy"
	| "warning"
	| "critical"
	| "expired"
	| "loading"
	| "error";

export function OAuthTokenStatus({
	accountName,
	hasRefreshToken,
	provider,
}: OAuthTokenStatusProps) {
	const [status, setStatus] = useState<TokenStatus>("loading");
	const [message, setMessage] = useState("Loading...");

	useEffect(() => {
		if (!hasRefreshToken) {
			return; // Don't fetch for non-OAuth accounts
		}

		// Add cancellation and delay to avoid overwhelming the server
		let cancelled = false;
		const timer = setTimeout(async () => {
			if (cancelled) return;

			try {
				const response = await api.getAccountTokenHealth(accountName);
				if (cancelled) return;

				if (response?.success) {
					setStatus(response.data.status);
					setMessage(response.data.message);
				} else {
					console.error("API returned error:", response);
					setStatus("error");
					setMessage("Failed to load token status");
				}
			} catch (error) {
				if (cancelled) return;
				console.error("Failed to fetch token status:", error);
				setStatus("error");
				setMessage("Failed to check token status");
			}
		}, 500); // 500ms delay

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [accountName, hasRefreshToken]);

	// Fallback: if initial fetch fails, try global token health
	useEffect(() => {
		if (status === "error" && hasRefreshToken) {
			let cancelled = false;

			const checkGlobalHealth = async () => {
				try {
					const globalResponse = await api.getTokenHealth();
					if (cancelled) return;

					if (globalResponse?.success && globalResponse.data?.accounts) {
						const accountData = globalResponse.data.accounts.find(
							(acc: any) => acc.accountName === accountName,
						);
						if (accountData) {
							setStatus(accountData.status);
							setMessage(accountData.message);
						}
					}
				} catch (error) {
					if (cancelled) return;
					console.error("Failed to fetch global health:", error);
				}
			};

			checkGlobalHealth();

			return () => {
				cancelled = true;
			};
		}
	}, [status, accountName, hasRefreshToken]);

	// Don't show anything for non-OAuth accounts
	if (!hasRefreshToken) {
		return null;
	}

	// Show loading during fallback attempt
	if (status === "error") {
		return (
			<span
				className="inline-flex items-center ml-2"
				title="OAuth refresh token status unknown - checking..."
			>
				<RefreshCw className="h-4 w-4 text-gray-400 animate-spin" />
			</span>
		);
	}

	const getIcon = () => {
		switch (status) {
			case "healthy":
				return <CheckCircle className="h-4 w-4 text-green-600" />;
			case "warning":
				return <AlertTriangle className="h-4 w-4 text-yellow-600" />;
			case "critical":
			case "expired":
				return <XCircle className="h-4 w-4 text-red-600" />;
			case "loading":
				return <RefreshCw className="h-4 w-4 text-gray-400 animate-spin" />;
			default:
				return <AlertTriangle className="h-4 w-4 text-gray-500" />;
		}
	};

	const getTooltip = () => {
		switch (status) {
			case "healthy":
				return "OAuth token available";
			case "warning":
				return `OAuth token expiring soon - ${message}`;
			case "critical":
			case "expired":
				return `OAuth token expired - ${message} - Re-authenticate with: bun run cli --reauthenticate ${accountName}`;
			case "loading":
				return "Checking OAuth token status...";
			default:
				return "OAuth token status unknown";
		}
	};

	return (
		<span className="inline-flex items-center ml-2" title={getTooltip()}>
			{getIcon()}
		</span>
	);
}
