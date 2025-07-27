export function getDashboardScript(): string {
	return `
let currentStrategy = 'session';
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
