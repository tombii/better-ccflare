import { getDashboardScript } from "./client";

export function getDashboardHTML(): string {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Load Balancer Dashboard</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
        }
        h1 {
            color: #333;
            margin: 0;
        }
        .strategy-selector {
            display: flex;
            align-items: center;
            gap: 10px;
            background: white;
            padding: 10px 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .strategy-selector label {
            font-weight: 500;
            color: #666;
        }
        .strategy-selector select {
            padding: 6px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            background: white;
            font-size: 14px;
            cursor: pointer;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .stat-card h3 {
            margin: 0 0 10px 0;
            color: #666;
            font-size: 14px;
            text-transform: uppercase;
        }
        .stat-value {
            font-size: 32px;
            font-weight: bold;
            color: #333;
        }
        .accounts-section, .requests-section {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid #eee;
        }
        th {
            font-weight: 600;
            color: #666;
        }
        .status-success {
            color: #10b981;
        }
        .status-error {
            color: #ef4444;
        }
        .rate-limited {
            color: #f59e0b;
            font-weight: 500;
        }
        .session-info {
            color: #6366f1;
            font-size: 12px;
        }
        .tier-selector {
            padding: 4px 8px;
            border: 1px solid #ddd;
            border-radius: 4px;
            background: white;
            font-size: 12px;
            cursor: pointer;
        }
        .tier-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            background: #e5e7eb;
            color: #374151;
        }
        .tier-badge.pro {
            background: #dbeafe;
            color: #1e40af;
        }
        .tier-badge.max5 {
            background: #fef3c7;
            color: #92400e;
        }
        .tier-badge.max20 {
            background: #ede9fe;
            color: #5b21b6;
        }
        .refresh-btn {
            background: #3b82f6;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .refresh-btn:hover {
            background: #2563eb;
        }
        .refresh-btn:disabled {
            background: #94a3b8;
            cursor: not-allowed;
        }
        .notification {
            position: fixed;
            top: 20px;
            right: 20px;
            background: #10b981;
            color: white;
            padding: 12px 20px;
            border-radius: 6px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            opacity: 0;
            transform: translateY(-10px);
            transition: all 0.3s ease;
        }
        .notification.show {
            opacity: 1;
            transform: translateY(0);
        }
        .notification.error {
            background: #ef4444;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Claude Load Balancer Dashboard</h1>
            <div class="strategy-selector">
                <label for="strategySelect">Load Balancing Strategy:</label>
                <select id="strategySelect" onchange="updateStrategy(this.value)">
                    <option value="least-requests">Least Requests</option>
                    <option value="round-robin">Round Robin</option>
                    <option value="session">Session Based</option>
                    <option value="weighted">Weighted (Tier-Aware)</option>
                    <option value="weighted-round-robin">Weighted Round Robin</option>
                </select>
            </div>
        </div>
        
        <div class="stats" id="stats">
            <div class="stat-card">
                <h3>Total Requests</h3>
                <div class="stat-value" id="totalRequests">-</div>
            </div>
            <div class="stat-card">
                <h3>Success Rate</h3>
                <div class="stat-value" id="successRate">-</div>
            </div>
            <div class="stat-card">
                <h3>Active Accounts</h3>
                <div class="stat-value" id="activeAccounts">-</div>
            </div>
            <div class="stat-card">
                <h3>Avg Response Time</h3>
                <div class="stat-value" id="avgResponseTime">-</div>
            </div>
        </div>

        <div class="accounts-section">
            <h2>Accounts</h2>
            <table id="accountsTable">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Tier</th>
                        <th>Requests</th>
                        <th>Last Used</th>
                        <th>Token Status</th>
                        <th>Rate Limit</th>
                        <th>Session</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>

        <div class="requests-section">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2>Recent Requests</h2>
                <button class="refresh-btn" onclick="refreshData()">Refresh</button>
            </div>
            <table id="requestsTable">
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Method</th>
                        <th>Path</th>
                        <th>Account</th>
                        <th>Status</th>
                        <th>Response Time</th>
                        <th>Failovers</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
    </div>

    <div id="notification" class="notification"></div>

    <script>${getDashboardScript()}</script>
</body>
</html>`;
}
