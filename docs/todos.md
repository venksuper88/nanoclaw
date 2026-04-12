# Todos & Reminders

## Unified Model

Reminders are a property on todos (`remind_at` field), not a separate entity.

## Data Model (`todos` table)

| Field | Type | Purpose |
|-------|------|---------|
| `id` | TEXT | Unique identifier |
| `user_id` | TEXT | Owner (memory_user_id of creating group) |
| `title` | TEXT | Todo text |
| `status` | TEXT | pending / done |
| `priority` | TEXT | high / medium / low |
| `due_date` | TEXT | Due date (ISO UTC) |
| `remind_at` | TEXT | Reminder fire time (ISO UTC) |
| `recurrence` | TEXT | daily / weekday / weekly / monthly / yearly |
| `reminder_fired_at` | TEXT | When reminder last fired (ISO) |
| `created_by` | TEXT | Source group folder |
| `created_at` | TEXT | Creation timestamp |

**All dates MUST be stored in UTC ISO format** — timezone offset strings break comparisons.

## Recurrence

- Presets: daily, weekday, weekly, monthly, yearly
- Completing a recurring todo advances `due_date` to next occurrence (doesn't mark done)
- Monthly recurrence handles short months via date clamping
- `remind_at` recomputed from recurrence cron expression after firing

## Reminder Firing (`src/task-scheduler.ts`)

Scheduler polls every 60s. Fires when `remind_at <= now AND reminder_fired_at IS NULL`:

1. Resolves target JID: token's `reminder_group_jid` > isMain group > first group with user
2. Sends reminder message to target group
3. Sets `reminder_fired_at` (keeps `remind_at` for overdue display)
4. For recurring: advances `remind_at` to next cron match

## Daily Digest

At 5:00 AM local (DIGEST_HOUR): sends daily todos summary grouped by status (overdue/upcoming/undated). Per-user, fired once per calendar day via `lastDigestDate` tracking in router_state.

## Agent Access

Agents use the `/todos` skill which calls the REST API (`/api/todos/*`).
See `container/skills/todos/SKILL.md` for the full curl reference.

## Frontend (`web/src/components/TodosView.tsx`)

- Todo form with separate due_date and remind_at date pickers
- Recurrence dropdown (daily/weekday/weekly/monthly/yearly/none)
- Priority badges, due date, reminder countdown, recurrence pattern
- Sorting: earliest date first (combines due_date and remind_at), then creation order
- Toggle completed/delete; recurring todos re-advance on completion

## IPC Snapshots

Todos written to `current_todos.json` in each group's IPC directory for agent read-only access. Mutations flow through IPC file -> db.ts -> watcher.
