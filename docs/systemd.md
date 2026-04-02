# Systemd Deployment Guide

Production deployment of better-ccflare as a systemd service on Linux.

## Reference Unit File

```ini
[Unit]
Description=better-ccflare proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=better-ccflare
Group=better-ccflare

# --- Environment ---
Environment=PORT=8889
Environment=BUN_JSC_forceRAMSize=2147483648

# --- Preflight: strip invalid BUN_JSC_* vars before Bun starts ---
ExecStartPre=/opt/better-ccflare/scripts/preflight-env.sh

# --- Main process ---
# --smol enables aggressive GC (the correct way to reduce memory usage)
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889

# --- Resource limits ---
MemoryMax=3G
MemoryHigh=2G
CPUQuota=200%

# --- Restart policy ---
Restart=always
RestartSec=5
StartLimitIntervalSec=120
StartLimitBurst=5

# --- Security hardening ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/better-ccflare
PrivateTmp=true

# --- Logging ---
StandardOutput=journal
StandardError=journal
SyslogIdentifier=better-ccflare

[Install]
WantedBy=multi-user.target
```

## Memory Management

### The `--smol` flag (recommended)

The `--smol` CLI flag is Bun's **supported** mechanism for reducing memory usage. It enables aggressive garbage collection and is safe for production use:

```ini
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889
```

This is equivalent to JavaScriptCore's "small heap" mode but exposed through Bun's stable CLI interface.

### `BUN_JSC_*` environment variables (dangerous)

Bun exposes `BUN_JSC_*` environment variables that map to internal JavaScriptCore options. These are **unstable, undocumented, and change between Bun versions**.

The critical problem: Bun validates these variables in C++ runtime **before any JavaScript executes**. If an invalid variable is set, Bun exits with code 1 immediately. No user code can catch or prevent this crash.

**Known-valid variables** (use with caution, may break in future Bun versions):

| Variable | Purpose | Example |
|---|---|---|
| `BUN_JSC_forceRAMSize` | Cap JSC heap size in bytes | `2147483648` (2 GB) |
| `BUN_JSC_useJIT` | Disable JIT compilation | `0` |
| `BUN_JSC_forceGCSlowPaths` | Force slow GC paths (debug) | `1` |

**Invalid variables that will crash Bun:**

| Variable | Why it fails |
|---|---|
| `BUN_JSC_smallHeap` | Not a real JSC option despite the name |
| `BUN_JSC_aggressiveGC` | Not a real JSC option |
| Any typo or guess | JSC option validation is strict |

### Rule of thumb

Use `--smol` for memory tuning. Use `BUN_JSC_forceRAMSize` only if you need a specific heap cap. Avoid all other `BUN_JSC_*` variables unless you have verified them against Bun's source code for your exact version.

## Preflight Environment Validator

The `scripts/preflight-env.sh` script strips invalid `BUN_JSC_*` environment variables before Bun starts. It uses an allowlist of known-valid variables and unsets anything else with a warning to stderr.

### Wiring as ExecStartPre

```ini
ExecStartPre=/opt/better-ccflare/scripts/preflight-env.sh
ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889
```

systemd runs `ExecStartPre` before the main process. If a stale or invalid `BUN_JSC_*` variable exists in the environment (from a previous configuration, an inherited environment, or a mistake in the unit file), the preflight script catches it.

### Sourcing interactively

When running better-ccflare outside systemd, source the script before starting:

```sh
. /opt/better-ccflare/scripts/preflight-env.sh
exec bun run better-ccflare --smol --serve
```

## Resource Limits

### Memory

```ini
MemoryMax=3G      # Hard kill if exceeded (OOM)
MemoryHigh=2G     # Kernel applies memory pressure, reclaims pages
```

Set `MemoryMax` above what the process actually needs. `MemoryHigh` applies back-pressure before the hard limit. Combined with `--smol`, this keeps better-ccflare within predictable bounds.

### CPU

```ini
CPUQuota=200%     # Allow up to 2 CPU cores
```

Adjust based on your expected request volume. For most single-proxy deployments, 100-200% is sufficient.

## Restart Policy Best Practices

```ini
Restart=always
RestartSec=5
StartLimitIntervalSec=120
StartLimitBurst=5
```

This means:

- systemd restarts the process on any exit (including crashes)
- It waits 5 seconds between restart attempts
- If the process crashes 5 times within 120 seconds, systemd stops trying and marks the unit as failed
- After a `StartLimitBurst` failure, manual intervention is required: `systemctl reset-failed better-ccflare && systemctl start better-ccflare`

Without the preflight script, an invalid `BUN_JSC_*` variable would burn through all 5 restart attempts in ~25 seconds, causing total proxy downtime until an operator notices.

## Common Pitfalls

### BUN_JSC_smallHeap crash loop

**Symptom:** Service fails immediately on start, burns through `StartLimitBurst`, then stays in failed state.

**Cause:** `BUN_JSC_smallHeap=1` (or similar invalid variable) set in the unit file or inherited environment. Bun validates this in C++ before JavaScript runs, exits code 1.

**Fix:** Remove the invalid variable from the unit file. Use `--smol` flag on `ExecStart` instead. Add the preflight script as `ExecStartPre` to prevent recurrence.

```sh
# Check journal for the crash
journalctl -u better-ccflare --no-pager -n 20

# Reset the failed state
systemctl reset-failed better-ccflare

# Fix the unit file, then reload and start
systemctl daemon-reload
systemctl start better-ccflare
```

### Forgetting daemon-reload

After editing a unit file, you must run `systemctl daemon-reload` before restarting the service. Otherwise systemd uses the cached version.

### Running as root

The reference unit file uses a dedicated `better-ccflare` user. Create it:

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin better-ccflare
mkdir -p /var/lib/better-ccflare
chown better-ccflare:better-ccflare /var/lib/better-ccflare
```

### Database path permissions

If using the default SQLite database, ensure the service user has write access:

```sh
mkdir -p /var/lib/better-ccflare
chown better-ccflare:better-ccflare /var/lib/better-ccflare
```

Set the database path in the unit file:

```ini
Environment=BETTER_CCFLARE_DB_PATH=/var/lib/better-ccflare/better-ccflare.db
```
