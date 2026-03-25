---
name: status
description: Quick read-only health check — session context, workspace, tool availability, and task snapshot. Use when the user asks for system status or runs /status.
---

# /status — System Status Check

Generate a quick read-only status report of the current agent environment.

## Detect mode

```bash
# tmux mode: NANOCLAW_IPC_DIR is set, no /workspace/
# container mode: /workspace/ exists
if [ -n "$NANOCLAW_IPC_DIR" ]; then
  echo "MODE: tmux"
  echo "IPC_DIR: $NANOCLAW_IPC_DIR"
  echo "GROUP: $NANOCLAW_GROUP_FOLDER"
  echo "IS_MAIN: $NANOCLAW_IS_MAIN"
elif [ -d /workspace ]; then
  echo "MODE: container"
else
  echo "MODE: unknown"
fi
```

## How to gather the information

### 1. Session context

```bash
echo "Timestamp: $(date)"
echo "Working dir: $(pwd)"
echo "Mode: ${NANOCLAW_IPC_DIR:+tmux}${NANOCLAW_IPC_DIR:-container}"
```

### 2. Workspace visibility

```bash
echo "=== Group folder ==="
ls "$(pwd)" 2>/dev/null | head -20
echo "=== IPC ==="
IPC_DIR="${NANOCLAW_IPC_DIR:-/workspace/ipc}"
ls "$IPC_DIR" 2>/dev/null || echo "none"
```

### 3. Tool availability

Confirm which tool families are available to you:

- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **MCP:** mcp__nanoclaw__* (send_message, save_memory, schedule_task, list_tasks, pause_task, resume_task, cancel_task, update_task, register_group)

### 4. Runtime info

```bash
node --version 2>/dev/null
claude --version 2>/dev/null || claude-lts --version 2>/dev/null
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not installed"
```

### 5. Task snapshot

Use the MCP tool to list tasks:

```
Call mcp__nanoclaw__list_tasks to get scheduled tasks.
```

If no tasks exist, report "No scheduled tasks."

## Report format

Present as a clean, readable message:

```
🔍 *Status*

*Session:*
• Mode: tmux / container
• Time: 2026-03-14 09:30 UTC
• Working dir: /path/to/group

*Tools:*
• Core: ✓  Web: ✓  Orchestration: ✓  MCP: ✓

*Runtime:*
• Node: vXX.X.X
• Claude Code: vX.X.X

*Scheduled Tasks:*
• N active tasks / No scheduled tasks
```

Adapt based on what you actually find. Keep it concise.

**See also:** `/capabilities` for a full list of installed skills and tools.
