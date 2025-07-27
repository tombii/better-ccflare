export interface Account {
	id: string;
	name: string;
	provider: string;
	requestCount: number;
	totalRequests: number;
	lastUsed: string | null;
	created: string;
	tier: number;
	tokenStatus: string;
	rateLimitStatus: string;
	sessionInfo: string | null;
}

export interface Stats {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	accounts: Array<{
		name: string;
		requestCount: number;
		successRate: number;
	}>;
	recentErrors: string[];
}

export interface LogEntry {
	ts: number;
	level: string;
	msg: string;
}

class API {
	private baseUrl = "";

	async getStats(): Promise<Stats> {
		const res = await fetch(`${this.baseUrl}/api/stats`);
		if (!res.ok) throw new Error("Failed to fetch stats");
		return res.json() as Promise<Stats>;
	}

	async getAccounts(): Promise<Account[]> {
		const res = await fetch(`${this.baseUrl}/api/accounts`);
		if (!res.ok) throw new Error("Failed to fetch accounts");
		return res.json() as Promise<Account[]>;
	}

	async addAccount(data: {
		name: string;
		mode: "max" | "console";
		tier: number;
	}): Promise<void> {
		const res = await fetch(`${this.baseUrl}/api/accounts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) throw new Error("Failed to add account");
	}

	async removeAccount(name: string): Promise<void> {
		const res = await fetch(`${this.baseUrl}/api/accounts/${name}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error("Failed to remove account");
	}

	async resetStats(): Promise<void> {
		const res = await fetch(`${this.baseUrl}/api/stats/reset`, {
			method: "POST",
		});
		if (!res.ok) throw new Error("Failed to reset stats");
	}

	streamLogs(onLog: (log: LogEntry) => void): EventSource {
		const eventSource = new (EventSource as any)(
			`${this.baseUrl}/api/logs/stream`,
		);
		eventSource.onmessage = (event: any) => {
			const log = JSON.parse(event.data);
			onLog(log);
		};
		return eventSource;
	}
}

export const api = new API();
