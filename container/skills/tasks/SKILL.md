---
name: tasks
description: Schedule recurring or one-time tasks (cron, interval, once). Tasks run as full agent sessions. Visible in the Tasks tab of Mission Control.
---

# Scheduled Tasks

Schedule recurring or one-time tasks via the DevenClaw API. Tasks run as full agent sessions with access to all tools.

## Authentication

```bash
AUTH="Authorization: Bearer $NANOCLAW_API_TOKEN"
GRP="X-Group-Folder: $NANOCLAW_GROUP_FOLDER"
API="$NANOCLAW_API_URL"
```

## List tasks

```bash
curl -s -H "$AUTH" "$API/api/tasks" | jq '.data'
```

## Get task details

```bash
curl -s -H "$AUTH" "$API/api/tasks/TASK_ID" | jq '.data'
```

## Get task run logs

```bash
curl -s -H "$AUTH" "$API/api/tasks/TASK_ID/logs" | jq '.data'
```

## Create a task

```bash
curl -s -X POST -H "$AUTH" -H "$GRP" -H "Content-Type: application/json" \
  "$API/api/tasks" \
  -d '{
    "prompt": "Check the weather and send a morning briefing",
    "schedule_type": "cron",
    "schedule_value": "0 9 * * *",
    "context_mode": "isolated",
    "group_folder": "'$NANOCLAW_GROUP_FOLDER'",
    "chat_jid": "'$NANOCLAW_CHAT_JID'"
  }'
```

Required: `prompt`, `schedule_type`, `schedule_value`, `group_folder`, `chat_jid`.

### Schedule types

- **cron** — standard cron expression, all times LOCAL timezone
  - `"0 9 * * *"` — daily at 9am
  - `"*/5 * * * *"` — every 5 minutes
  - `"0 9 * * 1-5"` — weekdays at 9am
- **interval** — milliseconds between runs
  - `"300000"` — every 5 minutes
  - `"3600000"` — every hour
- **once** — run once at a specific local time (NO "Z" suffix!)
  - `"2026-04-15T15:30:00"` — local time, not UTC

### Context mode

- `"group"` — runs with chat history and memory. Use for tasks that need conversation context.
- `"isolated"` — fresh session, no history. Include all context in the prompt. Use for self-contained tasks.

If unsure: "remind me about our discussion" -> group. "Check weather daily" -> isolated.

## Update a task

```bash
curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  "$API/api/tasks/TASK_ID" \
  -d '{"prompt": "Updated prompt", "schedule_value": "0 10 * * *"}'
```

Updatable fields: `prompt`, `schedule_type`, `schedule_value`, `status`. Changing schedule recomputes next_run automatically.

## Pause a task

```bash
curl -s -X POST -H "$AUTH" "$API/api/tasks/TASK_ID/pause"
```

## Resume a task

```bash
curl -s -X POST -H "$AUTH" "$API/api/tasks/TASK_ID/resume"
```

## Delete a task

```bash
curl -s -X DELETE -H "$AUTH" "$API/api/tasks/TASK_ID"
```

## Tips

- The task agent's output is sent to the user/group automatically
- Use `send_message` in the prompt for immediate delivery
- Wrap output in `<internal>` tags to suppress it
- Include guidance in the prompt about messaging behavior (always send, only if something to report, never send)
