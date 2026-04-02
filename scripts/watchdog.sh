#!/bin/bash
# DevenClaw Watchdog — self-healing startup wrapper
# Sits between launchd and the Node process. Detects crash loops
# and auto-recovers by stashing broken changes and rebuilding.
#
# How it works:
#   1. launchd calls this script instead of node directly
#   2. On each start, check if we're in a crash loop (3+ crashes in 2 min)
#   3. If crash-looping: stash uncommitted changes, rebuild from clean state
#   4. Run the Node process (foreground, so launchd can monitor it)
#
# Crash state is tracked via a timestamp file. Each crash appends a timestamp.
# Timestamps older than 2 minutes are pruned on each run.

set -euo pipefail

PROJECT_DIR="/Users/deven/Projects/nanoclaw"
CRASH_FILE="$PROJECT_DIR/logs/crash_timestamps"
RECOVERY_LOG="$PROJECT_DIR/logs/watchdog.log"
NODE="/opt/homebrew/bin/node"
NPX="/opt/homebrew/bin/npx"
MAX_CRASHES=3
WINDOW_SECS=120

cd "$PROJECT_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$RECOVERY_LOG"
}

mkdir -p "$PROJECT_DIR/logs"

# ── Prune old crash timestamps (older than WINDOW_SECS) ──
if [ -f "$CRASH_FILE" ]; then
  now=$(date +%s)
  temp=$(mktemp)
  while read -r ts; do
    if [ $((now - ts)) -lt $WINDOW_SECS ]; then
      echo "$ts" >> "$temp"
    fi
  done < "$CRASH_FILE"
  mv "$temp" "$CRASH_FILE"
else
  touch "$CRASH_FILE"
fi

# ── Count recent crashes ──
crash_count=$(wc -l < "$CRASH_FILE" | tr -d ' ')

if [ "$crash_count" -ge "$MAX_CRASHES" ]; then
  log "CRASH LOOP DETECTED: $crash_count crashes in ${WINDOW_SECS}s window"

  # Check if there are uncommitted changes to stash
  if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
    stash_msg="watchdog-recovery-$(date +%Y%m%d-%H%M%S)"
    git stash push -m "$stash_msg" --include-untracked 2>/dev/null || true
    log "STASHED uncommitted changes as: $stash_msg"
  else
    log "No uncommitted changes to stash"
  fi

  # Clean dist/ and rebuild from clean git state
  log "Rebuilding from clean git state..."
  rm -rf dist/
  if $NPX tsc --skipLibCheck 2>>"$RECOVERY_LOG"; then
    log "REBUILD SUCCESS — starting service from clean state"
  else
    log "REBUILD FAILED even on clean state — service may not start"
  fi

  # Reset crash counter after recovery attempt
  : > "$CRASH_FILE"
fi

# ── Record this startup (will become a crash timestamp if process dies quickly) ──
start_ts=$(date +%s)
echo "$start_ts" >> "$CRASH_FILE"

# ── Start the Node process (foreground) ──
$NODE "$PROJECT_DIR/dist/index.js"
exit_code=$?

# ── If we get here, process exited ──
# If it ran for more than 30 seconds, it wasn't a startup crash — remove our timestamp
end_ts=$(date +%s)
runtime=$((end_ts - start_ts))
if [ "$runtime" -gt 30 ]; then
  # Clean exit or graceful shutdown, not a crash loop
  # Remove our startup timestamp
  grep -v "^${start_ts}$" "$CRASH_FILE" > "$CRASH_FILE.tmp" 2>/dev/null || true
  mv "$CRASH_FILE.tmp" "$CRASH_FILE" 2>/dev/null || true
  log "Process exited after ${runtime}s (code $exit_code) — not a crash"
else
  log "Process died after ${runtime}s (code $exit_code) — potential crash loop"
fi

exit $exit_code
