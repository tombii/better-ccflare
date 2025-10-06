import { useEffect, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

interface DebugLog {
	id: string;
	timestamp: string;
	level: "info" | "warn" | "error" | "debug";
	message: string;
	details?: unknown;
}

export function DebugPanel() {
	const [logs, setLogs] = useState<DebugLog[]>([]);
	const [isVisible, setIsVisible] = useState(false);

	useEffect(() => {
		if (!isVisible) return;

		const originalConsole = { ...console };

		// Override console methods to capture logs
		const logLevels: Array<"info" | "warn" | "error" | "debug"> = [
			"info",
			"warn",
			"error",
			"debug",
		];

		logLevels.forEach((level) => {
			(console as any)[level] = (...args: unknown[]) => {
				const logEntry: DebugLog = {
					id: Math.random().toString(36).substr(2, 9),
					timestamp: new Date().toISOString(),
					level,
					message: args.join(" "),
					details: args.length > 1 ? args : undefined,
				};
				setLogs((prev) => [logEntry, ...prev.slice(0, 99)]); // Keep last 100 logs
				originalConsole[level](...args);
			};
		});

		return () => {
			Object.assign(console, originalConsole);
		};
	}, [isVisible]);

	if (!isVisible) {
		return (
			<Button
				onClick={() => setIsVisible(true)}
				className="fixed bottom-4 right-4 z-50"
				size="sm"
			>
				🐛 Debug
			</Button>
		);
	}

	const getLogColor = (level: string) => {
		switch (level) {
			case "error":
				return "text-destructive";
			case "warn":
				return "text-yellow-600";
			case "info":
				return "text-blue-600";
			case "debug":
				return "text-muted-foreground";
			default:
				return "";
		}
	};

	return (
		<Card className="fixed bottom-4 right-4 w-96 max-h-96 z-50">
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<CardTitle className="text-sm">Debug Panel</CardTitle>
					<Button onClick={() => setIsVisible(false)} variant="ghost" size="sm">
						✕
					</Button>
				</div>
			</CardHeader>
			<CardContent className="pt-0">
				<div className="space-y-1 max-h-64 overflow-y-auto text-xs font-mono">
					{logs.length === 0 ? (
						<p className="text-muted-foreground">No logs yet...</p>
					) : (
						logs.map((log) => (
							<div key={log.id} className="flex gap-2">
								<span className="text-muted-foreground">
									{new Date(log.timestamp).toLocaleTimeString()}
								</span>
								<Badge
									variant="outline"
									className={`text-xs ${getLogColor(log.level)}`}
								>
									{log.level}
								</Badge>
								<span className="flex-1 break-all">{log.message}</span>
							</div>
						))
					)}
				</div>
			</CardContent>
		</Card>
	);
}
