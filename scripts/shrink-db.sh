#!/usr/bin/env bash
#
# shrink-db.sh — prune old request payloads and reclaim disk for a bloated
# better-ccflare SQLite database, WITHOUT a full blocking VACUUM.
#
# WHY THIS SCRIPT EXISTS
#   On a busy proxy the request_payloads table can grow to tens of GB (full
#   request/response JSON, capped at 4 MiB request + 256 KiB response each).
#   Retention deletes keep the *logical* window bounded, but with
#   auto_vacuum=INCREMENTAL the freed pages are recycled by new inserts and
#   the file stays at its high-water mark until you explicitly return pages to
#   the OS. This script does that the safe way: prune, checkpoint, then
#   incremental_vacuum in bounded chunks — each chunk a short write
#   transaction that shares the writer slot with the live proxy via
#   busy_timeout, instead of one multi-minute exclusive VACUUM.
#
# SAFETY
#   * Runs against the LIVE database while the proxy keeps serving. Each step
#     uses a busy_timeout so it backs off rather than fighting the proxy.
#   * Prefer running during a low-traffic window — deletes and vacuum chunks
#     contend for SQLite's single writer slot.
#   * Does NOT take the proxy offline. Does NOT do a full VACUUM by default
#     (that needs an exclusive lock + up to ~1x the DB size in temp space).
#   * Idempotent and resumable: re-run any time; it only ever removes rows
#     older than the retention window and reclaims already-free pages.
#
# USAGE
#   scripts/shrink-db.sh [--days N] [--dry-run] [--chunk PAGES] [--full-vacuum] [--yes]
#
#   --days N        Delete payloads older than N days (default: 1).
#                   Request *metadata* (the `requests` table) is left alone.
#   --dry-run       Report what would be deleted/reclaimed; change nothing.
#   --chunk PAGES   Pages per incremental_vacuum step (default: 65536 = 256 MiB
#                   at 4 KiB pages). Smaller = shorter writer holds.
#   --full-vacuum   After pruning, run a full blocking VACUUM instead of
#                   incremental. EXCLUSIVE lock; stalls the proxy for minutes;
#                   needs free disk ~= final DB size. Use only in a real
#                   maintenance window.
#   --yes           Skip the confirmation prompt.
#
# ENV
#   BETTER_CCFLARE_DB_PATH   Override DB path (default:
#                            ~/.config/better-ccflare/better-ccflare.db)
#
set -euo pipefail

DAYS=1
DRY_RUN=0
CHUNK=65536
FULL_VACUUM=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--days) DAYS="${2:?--days needs a value}"; shift 2 ;;
		--dry-run) DRY_RUN=1; shift ;;
		--chunk) CHUNK="${2:?--chunk needs a value}"; shift 2 ;;
		--full-vacuum) FULL_VACUUM=1; shift ;;
		--yes) ASSUME_YES=1; shift ;;
		-h|--help) sed -n '2,52p' "$0"; exit 0 ;;
		*) echo "Unknown arg: $1" >&2; exit 2 ;;
	esac
done

DB="${BETTER_CCFLARE_DB_PATH:-$HOME/.config/better-ccflare/better-ccflare.db}"

if ! command -v sqlite3 >/dev/null 2>&1; then
	echo "ERROR: sqlite3 not found on PATH." >&2; exit 1
fi
if [[ ! -f "$DB" ]]; then
	echo "ERROR: database not found at: $DB" >&2
	echo "Set BETTER_CCFLARE_DB_PATH if it lives elsewhere." >&2; exit 1
fi

# Validate numeric args.
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "ERROR: --days must be an integer" >&2; exit 2; }
[[ "$CHUNK" =~ ^[0-9]+$ && "$CHUNK" -ge 1 ]] || { echo "ERROR: --chunk must be a positive integer" >&2; exit 2; }

# 10s busy timeout so every statement backs off under proxy write contention
# instead of erroring out immediately. `.timeout` is a dot-command (no output
# row), unlike `PRAGMA busy_timeout` which would print its value and corrupt
# scalar query captures below.
SQLITE=(sqlite3 -cmd ".timeout 10000" "$DB")

human() { # bytes -> human readable
	awk -v b="$1" 'BEGIN{ s="B KB MB GB TB"; split(s,u," "); i=1; while(b>=1024 && i<5){b/=1024;i++} printf "%.2f %s", b, u[i] }'
}

cutoff_ms() { # N days ago, as Unix ms epoch (matches request_payloads.timestamp)
	"${SQLITE[@]}" "SELECT CAST(strftime('%s','now','-$DAYS days') AS INTEGER) * 1000;"
}

echo "=== better-ccflare DB shrink ==="
echo "DB:            $DB"
PAGE_SIZE="$("${SQLITE[@]}" 'PRAGMA page_size;')"
AUTO_VACUUM="$("${SQLITE[@]}" 'PRAGMA auto_vacuum;')"
SIZE_BEFORE="$(stat -f%z "$DB" 2>/dev/null || stat -c%s "$DB")"
FREELIST_BEFORE="$("${SQLITE[@]}" 'PRAGMA freelist_count;')"
PAYLOAD_ROWS="$("${SQLITE[@]}" 'SELECT COUNT(*) FROM request_payloads;')"
PAYLOAD_BYTES="$("${SQLITE[@]}" 'SELECT COALESCE(SUM(LENGTH(json)),0) FROM request_payloads;')"
CUTOFF="$(cutoff_ms)"
OLD_ROWS="$("${SQLITE[@]}" "SELECT COUNT(*) FROM request_payloads WHERE timestamp IS NOT NULL AND timestamp < $CUTOFF;")"

echo "page_size:     $PAGE_SIZE   auto_vacuum: $AUTO_VACUUM (2=incremental)"
echo "file size:     $(human "$SIZE_BEFORE")"
echo "freelist:      $FREELIST_BEFORE pages (~$(human $((FREELIST_BEFORE * PAGE_SIZE))) reclaimable now)"
echo "payload rows:  $PAYLOAD_ROWS   payload bytes: $(human "$PAYLOAD_BYTES")"
echo "retention:     deleting payloads older than $DAYS day(s)  → $OLD_ROWS rows eligible"
echo

if [[ "$AUTO_VACUUM" != "2" && "$FULL_VACUUM" != "1" ]]; then
	echo "WARNING: auto_vacuum=$AUTO_VACUUM (not INCREMENTAL). incremental_vacuum will" >&2
	echo "         be a no-op. Use --full-vacuum, or let the server's startup migration" >&2
	echo "         convert the DB to incremental mode first." >&2
fi

if [[ "$DRY_RUN" == "1" ]]; then
	echo "[dry-run] Would delete $OLD_ROWS payload rows and reclaim free pages. No changes made."
	exit 0
fi

if [[ "$ASSUME_YES" != "1" ]]; then
	read -r -p "Proceed against the LIVE database? [y/N] " ans
	[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted."; exit 0; }
fi

# ---------------------------------------------------------------------------
# 1) Prune old payloads in small batches (matches the app's BATCH_SIZE=2000),
#    so each DELETE is a short transaction the proxy can interleave with.
# ---------------------------------------------------------------------------
echo "[1/3] Pruning payloads older than $DAYS day(s)…"
deleted_total=0
while :; do
	n="$("${SQLITE[@]}" "
		DELETE FROM request_payloads
		WHERE id IN (
			SELECT id FROM request_payloads
			WHERE timestamp IS NOT NULL AND timestamp < $CUTOFF
			LIMIT 2000
		);
		SELECT changes();
	")"
	deleted_total=$((deleted_total + n))
	printf '\r      deleted %s rows…' "$deleted_total"
	[[ "$n" -eq 2000 ]] || break
done
# Also sweep orphaned payloads (payload with no matching request row).
# Batched like the retention sweep above to avoid long writer-slot holds on
# large tables. Uses NOT EXISTS rather than NOT IN to avoid the NULL-trap
# (NOT IN returns UNKNOWN for every row when the subquery contains a NULL,
# silently deleting nothing).
while :; do
	orphans="$("${SQLITE[@]}" "
		DELETE FROM request_payloads
		WHERE id IN (
			SELECT rp.id FROM request_payloads rp
			WHERE NOT EXISTS (SELECT 1 FROM requests r WHERE r.id = rp.id)
			LIMIT 2000
		);
		SELECT changes();
	")"
	[[ "$orphans" -gt 0 ]] || break
done
echo " done ($deleted_total removed)."

# ---------------------------------------------------------------------------
# 2) Checkpoint the WAL so freed pages are visible to the vacuum, and the WAL
#    doesn't balloon from the deletes above.
# ---------------------------------------------------------------------------
echo "[2/3] Checkpointing WAL (TRUNCATE)…"
"${SQLITE[@]}" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || true

# ---------------------------------------------------------------------------
# 3) Reclaim free pages back to the OS.
# ---------------------------------------------------------------------------
if [[ "$FULL_VACUUM" == "1" ]]; then
	echo "[3/3] Running FULL VACUUM (exclusive lock — proxy writes will stall)…"
	AVAIL="$(df -k "$(dirname "$DB")" | awk 'NR==2{print $4*1024}')"
	if [[ "$AVAIL" -lt "$SIZE_BEFORE" ]]; then
		echo "ERROR: full VACUUM needs ~$(human "$SIZE_BEFORE") free; only $(human "$AVAIL") available." >&2
		echo "       Free disk or use the default incremental path instead." >&2
		exit 1
	fi
	time "${SQLITE[@]}" "VACUUM;"
else
	echo "[3/3] Reclaiming free pages via incremental_vacuum (chunk=$CHUNK pages)…"
	while :; do
		free="$("${SQLITE[@]}" 'PRAGMA freelist_count;')"
		[[ "$free" -gt 0 ]] || break
		"${SQLITE[@]}" "PRAGMA incremental_vacuum($CHUNK); PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
		now_size="$(stat -f%z "$DB" 2>/dev/null || stat -c%s "$DB")"
		printf '\r      freelist %s pages, file %s…   ' "$free" "$(human "$now_size")"
		# brief yield so the proxy's writer can slip in between chunks
		sleep 0.1
	done
	echo " done."
fi

SIZE_AFTER="$(stat -f%z "$DB" 2>/dev/null || stat -c%s "$DB")"
echo
echo "=== Result ==="
echo "before: $(human "$SIZE_BEFORE")"
echo "after:  $(human "$SIZE_AFTER")"
echo "freed:  $(human $((SIZE_BEFORE - SIZE_AFTER)))"
echo
echo "Tip: set a smaller retention window so it doesn't regrow —"
echo "     bun run cli  (Settings), or DATA_RETENTION_DAYS env, or"
echo "     POST /api/config/retention {\"payloadDays\": $DAYS}."
