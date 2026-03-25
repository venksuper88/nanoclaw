---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

## How to gather the information

### 1. Installed skills

List skill directories available to you:

```bash
# tmux mode: skills are in the project .claude/skills/
# container mode: skills are in /home/node/.claude/skills/
ls -1 .claude/skills/ 2>/dev/null || ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

### 2. Available tools

- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **Other:** TodoWrite, ToolSearch, Skill, NotebookEdit
- **MCP:** mcp__nanoclaw__* (messaging, tasks, memory, group management)

### 3. MCP server tools

The NanoClaw MCP server exposes:
- `send_message` — send a message to the user/group
- `send_file` — send a file attachment
- `save_memory` — save a fact to long-term memory (mem0)
- `schedule_task` — schedule a recurring or one-time task
- `list_tasks` — list scheduled tasks
- `pause_task` / `resume_task` / `cancel_task` / `update_task` — manage tasks
- `register_group` — register a new chat/group (main only)

### 4. Runtime tools

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
node --version 2>/dev/null
claude --version 2>/dev/null || claude-lts --version 2>/dev/null
```

### 5. Environment info

```bash
echo "Mode: ${NANOCLAW_IPC_DIR:+tmux}${NANOCLAW_IPC_DIR:-container}"
echo "Group: ${NANOCLAW_GROUP_FOLDER:-unknown}"
echo "Main: ${NANOCLAW_IS_MAIN:-0}"
ls CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
```

## Report format

```
📋 *Capabilities*

*Skills:*
• /agent-browser — Browse the web, fill forms, extract data
• /capabilities — This report
• /restart — Restart the service
• /status — Health check
(list all found)

*Tools:*
• Core: Bash, Read, Write, Edit, Glob, Grep
• Web: WebSearch, WebFetch
• Orchestration: Task, TeamCreate, SendMessage
• MCP: send_message, save_memory, schedule_task, list_tasks, register_group

*Runtime:*
• Mode: tmux / container
• Group memory: yes/no
• Main group: yes/no
```

Adapt based on what you find. Don't list things that aren't installed.

**See also:** `/status` for a quick health check.
