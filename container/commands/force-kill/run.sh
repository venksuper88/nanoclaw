#!/bin/bash
# Force-kill stuck claude-lts process for a group's tmux session.
# Preserves the tmux session and session ID so next message resumes.

FOLDER="${NANOCLAW_GROUP_FOLDER}"
if [ -z "$FOLDER" ]; then
  echo '{"status":"error","message":"No group folder specified"}'
  exit 1
fi

SESSION="nanoclaw-${FOLDER}"

# Check if tmux session exists
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo '{"status":"ok","message":"No tmux session found — nothing to kill"}'
  exit 0
fi

# Find claude-lts PID(s) running inside the tmux session's pane
PANE_PID=$(tmux display-message -t "$SESSION" -p '#{pane_pid}' 2>/dev/null)
if [ -z "$PANE_PID" ]; then
  echo '{"status":"error","message":"Could not find tmux pane PID"}'
  exit 1
fi

# Find all claude-lts processes that are children of the pane's shell
CLAUDE_PIDS=$(pgrep -P "$PANE_PID" -f "claude-lts" 2>/dev/null)
if [ -z "$CLAUDE_PIDS" ]; then
  # Also check grandchildren (shell -> node -> claude-lts)
  CHILD_PIDS=$(pgrep -P "$PANE_PID" 2>/dev/null)
  for cpid in $CHILD_PIDS; do
    MORE=$(pgrep -P "$cpid" -f "claude" 2>/dev/null)
    CLAUDE_PIDS="$CLAUDE_PIDS $MORE"
  done
  CLAUDE_PIDS=$(echo "$CLAUDE_PIDS" | xargs)
fi

if [ -z "$CLAUDE_PIDS" ]; then
  echo '{"status":"ok","message":"No claude-lts process running in session — already idle"}'
  exit 0
fi

# Kill them all (SIGKILL to force)
KILLED=0
for pid in $CLAUDE_PIDS; do
  if kill -9 "$pid" 2>/dev/null; then
    KILLED=$((KILLED + 1))
  fi
done

echo "{\"status\":\"ok\",\"message\":\"Killed $KILLED claude-lts process(es) in $SESSION. Session ID preserved — next message will resume.\"}"
