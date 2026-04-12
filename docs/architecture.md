# Architecture & Execution Model

## Message Loop (`src/index.ts`)

Single Node.js process. The orchestrator maintains persistent state (`lastTimestamp`, `sessions`, `registeredGroups`) and runs a poll loop:

1. Fetches new messages via channel APIs
2. Filters by sender allowlist and trigger pattern
3. Queues groups via GroupQueue (concurrency control, default 5 agents)
4. Processes per-group via `processGroupMessages`

## Tmux Sessions (`src/tmux-runner.ts`)

Per-group persistent tmux sessions (`nanoclaw-{folder}`) run `claude-lts -p`:

- Host writes enriched prompt to temp file
- Sends wrapper script via `tmux send-keys`
- Claude reads/edits/builds locally on the host Mac
- Responds via MCP `send_message` (picked up by IPC watcher)
- Wrapper writes done-marker; host detects completion
- Session ID persists in DB for resume via `--resume`

## IPC (`src/ipc.ts`)

Polls `data/ipc/{groupFolder}/{messages,tasks,memory}/` every 1s for file-based communication:

- **Messages**: Cross-agent messaging (authorization: main group or self-group)
- **Tasks**: CRUD operations (create, update, pause, resume, cancel)
- **Memory write-back**: Pre-compact fact extraction at session end
- Files validated per group folder, deleted after processing

## Session Commands (`src/session-commands.ts`)

Three slash commands intercepted by orchestrator:

| Command | Behavior |
|---------|----------|
| `/compact` | Forwarded to claude-lts built-in compaction |
| `/context` | Shows context% usage |
| `/new` | Clears session; next message starts fresh |

Authorization: main group or trusted sender (`is_from_me`).

## Group Queue (`src/group-queue.ts`)

Concurrency manager enforcing `MAX_CONCURRENT_AGENTS` (env configurable):

- `active`: Agent running; `idleWaiting`: done, waiting for IPC
- `pendingMessages`/`pendingTasks`: queued items
- Tasks prioritized over messages in drain logic
- Transient groups auto-close after 30s idle
- Retry backoff (5s base, 2^n multiplier) for crashed agents

## Message Formatting (`src/router.ts`)

- Images pre-compressed to 768x768 JPEG (60% quality) before Claude receives them
- `[Photo: file]` rewritten to absolute path + cached extraction summary
- XML formatting with timezone context and sender escaping

## Context%

Calculated from last assistant event: `(input + cache_creation + cache_read) / contextWindow * 100`

- Context window (200K for Opus/Sonnet) from `result` event's `modelUsage.contextWindow`
- Persisted to DB via `setRouterState('context_pct:{folder}', ...)`
- API falls back: in-memory cache -> DB -> 0

## Config (`src/config.ts`)

Key exports: `ASSISTANT_NAME`, `POLL_INTERVAL` (2s), `SCHEDULER_POLL_INTERVAL` (60s), `IDLE_TIMEOUT` (30min default), `MAX_CONCURRENT_AGENTS`, `TRIGGER_PATTERN`, `TIMEZONE`.
