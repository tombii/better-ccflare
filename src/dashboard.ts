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

export function getDashboardScript(): string {
	return `
let currentStrategy = 'least-requests';
let autoRefreshInterval;

async function fetchStats() {
    const response = await fetch('/api/stats');
    return response.json();
}

async function fetchAccounts() {
    const response = await fetch('/api/accounts');
    return response.json();
}

async function fetchRequests() {
    const response = await fetch('/api/requests?limit=50');
    return response.json();
}

async function fetchConfig() {
    const response = await fetch('/api/config');
    const config = await response.json();
    return config;
}

function formatDate(timestamp) {
    return new Date(timestamp).toLocaleString();
}

function formatResponseTime(ms) {
    if (!ms || ms === 0) return '0ms';
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (ms / 1000).toFixed(2) + 's';
}

function showNotification(message, isError = false) {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = 'notification' + (isError ? ' error' : '');
    notification.classList.add('show');
    
    setTimeout(() => {
        notification.classList.remove('show');
    }, 3000);
}

async function updateStrategy(strategy) {
    try {
        const response = await fetch('/api/config/strategy', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ strategy }),
        });
        
        if (response.ok) {
            showNotification(\`Strategy updated to \${strategy}\`);
            currentStrategy = strategy;
        } else {
            showNotification('Failed to update strategy', true);
            // Revert the select to current strategy
            document.getElementById('strategySelect').value = currentStrategy;
        }
    } catch (error) {
        console.error('Error updating strategy:', error);
        showNotification('Error updating strategy', true);
        document.getElementById('strategySelect').value = currentStrategy;
    }
}

function formatRateLimitStatus(account) {
    if (!account.rate_limited) {
        return '<span style="color: #10b981;">✅ Active</span>';
    }
    
    const now = Date.now();
    const remainingTime = account.rate_limited_until - now;
    const minutes = Math.ceil(remainingTime / 60000);
    
    if (minutes > 60) {
        const hours = Math.ceil(minutes / 60);
        return \`<span class="rate-limited">🚫 \${hours}h</span>\`;
    }
    
    return \`<span class="rate-limited">🚫 \${minutes}m</span>\`;
}

function getTierDisplay(tier) {
    switch(tier) {
        case 1:
            return '<span class="tier-badge pro">Pro Account</span>';
        case 5:
            return '<span class="tier-badge max5">Max 5x Account</span>';
        case 20:
            return '<span class="tier-badge max20">Max 20x Account</span>';
        default:
            return '<span class="tier-badge">Pro Account</span>';
    }
}

function createTierSelector(account) {
    const currentTier = account.account_tier || 1;
    return \`
        <select class="tier-selector" onchange="updateAccountTier('\${account.id}', this.value)" value="\${currentTier}">
            <option value="1" \${currentTier === 1 ? 'selected' : ''}>Pro (1x)</option>
            <option value="5" \${currentTier === 5 ? 'selected' : ''}>Max 5x</option>
            <option value="20" \${currentTier === 20 ? 'selected' : ''}>Max 20x</option>
        </select>
    \`;
}

function formatDuration(ms) {
    const minutes = Math.ceil(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return hours > 0 ? hours + 'h ' + remMinutes + 'm' : remMinutes + 'm';
}

function formatSessionInfo(account) {
    if (!account.session_start) {
        return 'No session';
    }
    const startTime = formatDate(account.session_start);
    const remainingMs = (account.session_start + 5 * 60 * 60 * 1000) - Date.now();
    const remainingStr = remainingMs <= 0 ? '0m' : formatDuration(remainingMs);
    return 'Started: ' + startTime + '<br/>Refresh in ' + remainingStr;
}

async function updateAccountTier(accountId, tier) {
    try {
        const response = await fetch(\`/api/accounts/\${accountId}/tier\`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ tier: parseInt(tier) }),
        });
        
        if (response.ok) {
            showNotification('Account tier updated successfully');
            // Refresh the dashboard to show updated data
            updateDashboard();
        } else {
            showNotification('Failed to update account tier', true);
        }
    } catch (error) {
        console.error('Error updating account tier:', error);
        showNotification('Error updating account tier', true);
    }
}

async function updateDashboard() {
    try {
        // Update stats
        const stats = await fetchStats();
        document.getElementById('totalRequests').textContent = stats.totalRequests || '0';
        document.getElementById('successRate').textContent = (stats.successRate || 0) + '%';
        document.getElementById('activeAccounts').textContent = stats.activeAccounts || '0';
        document.getElementById('avgResponseTime').textContent = formatResponseTime(stats.avgResponseTime);

        // Update accounts table
        const accounts = await fetchAccounts();
        const accountsTableBody = document.querySelector('#accountsTable tbody');
        accountsTableBody.innerHTML = accounts.map(account => \`
            <tr>
                <td>\${account.name}</td>
                <td>\${createTierSelector(account)}</td>
                <td>\${account.request_count}</td>
                <td>\${account.last_used ? formatDate(account.last_used) : 'Never'}</td>
                <td>\${account.token_valid ? '✅ Valid' : '❌ Expired'}</td>
                <td>\${formatRateLimitStatus(account)}</td>
                <td class="session-info">\${formatSessionInfo(account)}</td>
            </tr>
        \`).join('');

        // Update requests table
        const requests = await fetchRequests();
        const requestsTableBody = document.querySelector('#requestsTable tbody');
        requestsTableBody.innerHTML = requests.map(request => \`
            <tr>
                <td>\${formatDate(request.timestamp)}</td>
                <td>\${request.method}</td>
                <td>\${request.path}</td>
                <td>\${request.account_name || request.account_used || 'N/A'}</td>
                <td class="\${request.success ? 'status-success' : 'status-error'}">
                    \${request.status_code || 'Failed'}
                </td>
                <td>\${formatResponseTime(request.response_time_ms)}</td>
                <td>\${request.failover_attempts}</td>
            </tr>
        \`).join('');
    } catch (error) {
        console.error('Error updating dashboard:', error);
    }
}

async function fetchStrategies() {
    const response = await fetch('/api/strategies');
    return await response.json();
}

function formatStrategyName(strategy) {
    const names = {
        'least-requests': 'Least Requests',
        'round-robin': 'Round Robin',
        'session': 'Session Based',
        'weighted': 'Weighted (Tier-Aware)',
        'weighted-round-robin': 'Weighted Round Robin'
    };
    return names[strategy] || strategy;
}

async function initializeDashboard() {
    try {
        // Fetch and populate strategies
        const strategies = await fetchStrategies();
        const strategySelect = document.getElementById('strategySelect');
        strategySelect.innerHTML = strategies.map(strategy => 
            \`<option value="\${strategy}">\${formatStrategyName(strategy)}</option>\`
        ).join('');
        
        // Fetch current config
        const config = await fetchConfig();
        currentStrategy = config.lb_strategy || 'least-requests';
        strategySelect.value = currentStrategy;
        
        // Initial dashboard update
        await updateDashboard();
        
        // Set up auto-refresh
        autoRefreshInterval = setInterval(updateDashboard, 5000);
    } catch (error) {
        console.error('Error initializing dashboard:', error);
    }
}

function refreshData() {
    updateDashboard();
}

// Initialize on load
initializeDashboard();

// Make functions available globally
window.updateAccountTier = updateAccountTier;
window.updateStrategy = updateStrategy;
window.refreshData = refreshData;

// Clean up interval on page unload
window.addEventListener('beforeunload', () => {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }
});
`;
}
