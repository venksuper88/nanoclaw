---
name: todos
description: Create, update, complete, delete, and list todos and reminders. Todos appear in the Todos tab of Mission Control. A reminder is a todo with remind_at set.
---

# Todos

Manage todos and reminders via the DevenClaw API. Todos support priority, due dates, reminders, and recurrence. They appear in the Todos tab of Mission Control.

## Authentication

```bash
AUTH="Authorization: Bearer $NANOCLAW_API_TOKEN"
GRP="X-Group-Folder: $NANOCLAW_GROUP_FOLDER"
API="$NANOCLAW_API_URL"
```

## List todos

```bash
curl -s -H "$AUTH" "$API/api/todos" | jq '.data'
```

## Create a todo

```bash
curl -s -X POST -H "$AUTH" -H "$GRP" -H "Content-Type: application/json" \
  "$API/api/todos" \
  -d '{"title": "Review PR", "priority": "high", "due_date": "2026-04-15T09:00:00Z"}'
```

Required: `title`. Optional fields:
- `data` — additional notes (markdown)
- `priority` — `low`, `medium` (default), or `high`
- `due_date` — ISO timestamp (UTC)
- `remind_at` — when to send a reminder notification (ISO timestamp, UTC)
- `recurrence` — `daily`, `weekday`, `weekly`, `monthly`, or `yearly`

A **reminder** is just a todo with `remind_at` set. For reminders without a visible todo, set a descriptive title.

## Update a todo

```bash
curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  "$API/api/todos/TODO_ID" \
  -d '{"priority": "low", "due_date": "2026-04-20T09:00:00Z"}'
```

Any combination of: `title`, `data`, `status`, `priority`, `due_date`, `remind_at`, `recurrence`.

Status values: `pending`, `in_progress`, `done`.

## Complete a todo

```bash
curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  "$API/api/todos/TODO_ID" \
  -d '{"status": "done"}'
```

Recurring todos auto-advance to the next due date instead of being marked done.

## Delete a todo

```bash
curl -s -X DELETE -H "$AUTH" "$API/api/todos/TODO_ID"
```

## Tips

- Use `remind_at` for time-sensitive notifications — the scheduler fires reminders automatically
- Recurring todos (`recurrence` field) reset their due date when completed
- Always set `priority` for important items so they sort correctly in the UI
- The `X-Group-Folder` header records which agent created the todo
