---
name: restart
description: Gracefully restart the DevenClaw service. Main group only. Use when the user asks to restart, or after deploying code changes.
---

# /restart — Restart DevenClaw

Gracefully restarts the DevenClaw service. All running containers will be stopped and the process will exit, then launchd restarts it automatically.

## How to restart

Find the IPC directory and write a restart file:

```bash
# Works in both tmux mode (host path) and container mode (/workspace/ipc)
IPC_DIR="${NANOCLAW_IPC_DIR:-/workspace/ipc}"
mkdir -p "$IPC_DIR/tasks"
cat > "$IPC_DIR/tasks/restart-$(date +%s).json" << 'EOF'
{"type": "restart_service", "reason": "user requested /restart"}
EOF
echo "Restart requested"
```

Then respond:

> Restarting DevenClaw... Service will be back in a few seconds.

**Do NOT use launchctl or kill commands.** The IPC handler manages the restart gracefully.
