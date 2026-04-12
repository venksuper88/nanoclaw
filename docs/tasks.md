# Tasks (Scheduled Tasks)

## Overview

Tasks are scheduled agent invocations that run automatically. The scheduler (`src/task-scheduler.ts`) polls every 30 seconds for due tasks and executes them via tmux agents.

## Schedule Types

| Type | Value | Behavior |
|------|-------|----------|
| `once` | ISO timestamp | Single execution, marked completed after |
| `cron` | Cron expression | Recurring on cron schedule (timezone-aware) |
| `interval` | Milliseconds | Recurring at fixed interval |

Next run is anchored to scheduled time (not current time) to prevent cumulative drift.

## Data Model

### `scheduled_tasks` table

| Field | Type | Purpose |
|-------|------|---------|
| `id` | TEXT | Unique identifier |
| `prompt` | TEXT | Agent instruction text |
| `schedule_type` | TEXT | 'cron' / 'interval' / 'once' |
| `schedule_value` | TEXT | Cron string, milliseconds, or ISO timestamp |
| `context_mode` | TEXT | 'group' (with session history) or 'isolated' (fresh) |
| `status` | TEXT | 'active' / 'paused' / 'completed' |
| `next_run` | TEXT | Next scheduled execution (ISO) |
| `last_run` | TEXT | Last execution time |
| `last_result` | TEXT | Last execution output |
| `chat_jid` | TEXT | Target group JID |
| `group_folder` | TEXT | Target group folder |

### `task_run_logs` table
Captures `run_at`, `duration_ms`, `status` (success/error), `result`, and `error` for audit.

## Execution Model

- Tasks run as single-turn agents in tmux
- `group` context: uses existing session history
- `isolated` context: fresh session each run
- Output streams to dashboard in real-time
- Session closes 10s after completion
- Execution serialized per chat JID to prevent races

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/tasks` | List all tasks (filtered by user access) |
| `GET /api/tasks/:id/logs` | Fetch run history |
| `POST /api/tasks/:id/pause` | Pause task |
| `POST /api/tasks/:id/resume` | Resume task |
| `DELETE /api/tasks/:id` | Delete task |

## Agent Access

Agents use the `/tasks` skill which calls the REST API (`/api/tasks/*`).
See `container/skills/tasks/SKILL.md` for the full curl reference.

## Frontend (`web/src/components/TasksView.tsx`)

Card list showing schedule, next/last run times, last result. Users can pause/resume, view execution logs with status indicators, and delete completed tasks.

## IPC Snapshots

`writeTasksSnapshot()` writes filtered task list to `current_tasks.json` in each group's IPC directory. Main groups see all tasks; others see only their own.
