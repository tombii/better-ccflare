import { CheckCircle, AlertTriangle, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";

interface OAuthTokenStatusProps {
	accountName: string;
	hasRefreshToken: boolean;
	provider: string;
}

type TokenStatus = "healthy" | "warning" | "critical" | "expired" | "loading" | "error";

export function OAuthTokenStatus({ accountName, hasRefreshToken, provider }: OAuthTokenStatusProps) {
	const [status, setStatus] = useState<TokenStatus>("loading");
	const [message, setMessage] = useState("Loading...");

	useEffect(() => {
		if (!hasRefreshToken) {
			return; // Don't fetch for non-OAuth accounts
		}

		const fetchTokenStatus = async () => {
			try {
				const response = await api.getAccountTokenHealth(accountName);
				if (response.success) {
					setStatus(response.data.status);
					setMessage(response.data.message);
				} else {
					setStatus("error");
					setMessage("Failed to load token status");
				}
			} catch (error) {
				setStatus("error");
				setMessage("Failed to load token status");
			}
		};

		fetchTokenStatus();
	}, [accountName, hasRefreshToken]);

	// Don't show anything for non-OAuth accounts
	if (!hasRefreshToken) {
		return null;
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
			case "error":
			default:
				return <AlertTriangle className="h-4 w-4 text-gray-400" />;
		}
	};

	const getTooltip = () => {
		switch (status) {
			case "healthy":
				return "OAuth refresh token valid";
			case "warning":
				return `${message} - Consider re-authenticating soon`;
			case "critical":
			case "expired":
				return `${message} - Please re-authenticate: bun run cli --reauthenticate ${accountName}`;
			case "loading":
				return "Checking token status...";
			case "error":
			default:
				return "Failed to check token status";
		}
	};

	return (
		<span
			className="inline-flex items-center ml-2"
			title={getTooltip()}
		>
			{getIcon()}
		</span>
	);
}