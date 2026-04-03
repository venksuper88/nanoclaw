# DevenClaw

Personal AI assistant platform. Node.js + TypeScript. Runs Claude agents via persistent tmux sessions (`claude-lts -p`). Web dashboard at `mc.neved.in`.

## Quick Start

```bash
npm run dev            # Run with hot reload
npm run build          # Compile TypeScript (backend)
cd web && npm run build # Build React frontend
npx tsc --skipLibCheck  # Type-check only
```

Service management (macOS):
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Architecture

Single Node.js process. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) self-register at startup. Messages route to Claude agents running in tmux sessions. Each group has isolated filesystem, IPC, and memory.

### Execution Model

- **tmux-only** — no containers. Each group gets a tmux session running `claude-lts -p`
- **MCP tools** — agents communicate via `ipc-mcp-stdio.js` (send_message, todos, tasks, memory, etc.)
- **IPC** — file-based per-group messaging in `groups/{folder}/ipc/`
- **Skills** sync every turn via `setupClaudeConfig` — no restart needed. Syncs both `container/skills/` and `~/.claude/skills/` (global user skills)
- **MCP tools** are negotiated once at session start — new tools require new session
- **Session commands** — `/context`, `/compact`, `/new` intercepted by orchestrator

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: message loop, agent invocation, context% tracking |
| `src/tmux-runner.ts` | Tmux session management, `claude-lts -p` invocation |
| `src/ipc.ts` | IPC watcher: messages, tasks, todos, memory, restart |
| `src/ipc-snapshots.ts` | Task/todo/reminder snapshot writers for agent IPC |
| `src/task-scheduler.ts` | Runs scheduled tasks, fires todo reminders |
| `src/session-commands.ts` | `/context`, `/compact`, `/new` command handling |
| `src/db.ts` | Turso/SQLite operations (async `@libsql/client`) |
| `src/memory.ts` | mem0 integration, inject-once, scope filtering |
| `src/router.ts` | Message formatting and outbound routing |
| `src/group-queue.ts` | Per-group concurrency control |
| `src/config.ts` | All config exports (env vars, paths, Turso) |
| `src/types.ts` | TypeScript interfaces |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/dashboard/routes.ts` | Express API routes |
| `src/dashboard/events.ts` | Dashboard socket.io event hub |
| `src/dashboard/auth.ts` | Token authentication |
| `src/dashboard/server.ts` | Express + socket.io server |
| `web/src/App.tsx` | React app entry (tabs: Chat, Overview, Tasks, Todos, Settings) |
| `web/src/components/` | ChatView, OverviewView, TasksView, TodosView, SettingsView |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server source |
| `groups/{name}/CLAUDE.md` | Per-group agent instructions (isolated) |

## Data Model

### Groups & Users
- Groups are registered in `registered_groups` table with folder, trigger, config
- User scoping via `memory_user_id` on each group ("venky" or "devi")
- Dashboard tokens in `dashboard_tokens` table with `reminder_group_jid` per user

### Todos & Reminders (unified model)
- Reminders are a property on todos (`remind_at` field), **not** a separate entity
- Legacy `reminders` table and `add_reminder` MCP tools have been removed — use `add_todo` with `remind_at` and `recurrence` params
- `reminder_fired_at` tracks fired reminders (keeps `remind_at` for overdue display)
- Recurring todos use preset `recurrence` values: daily, weekday, weekly, monthly, yearly
- Completing a recurring todo advances `due_date` to the next occurrence instead of marking done
- Daily digest at 5 AM sends each user's upcoming/overdue todos to their main group
- **All dates MUST be stored in UTC ISO format** — timezone offset strings break comparisons

### Context%
- Calculated from last assistant event usage: `(input + cache_creation + cache_read) / contextWindow * 100`
- Context window size (200K for Opus/Sonnet) extracted from `result` event's `modelUsage.contextWindow`, fallback 200K
- Persisted to Turso via `setRouterState('context_pct:{folder}', ...)`
- API falls back: in-memory cache -> DB -> 0

### Attachments & Images
- Uploaded files stored in `groups/{folder}/attachments/`
- `send_message` MCP tool supports `filePath` param for outbound file sending
- Inbound images: `expandAttachments()` rewrites `[Photo: file]` → "Use Read tool to view at: {path}"
- **Images are auto-compressed in-place** on upload and before each agent turn (768px max, JPEG q60 via Sharp). Reading images costs ~500-800 tokens instead of 5-15K.
- **All dates MUST be stored in UTC ISO format** — timezone offset strings break comparisons

## Skills

Four types of skills exist. See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent sessions at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Troubleshooting, logs, session issues |
| `/restart` | Gracefully restart DevenClaw service |
| `/create-claude-md` | Create well-structured CLAUDE.md for any project |
| `/create-skill` | Create new Claude Code skills following best practices |
| `/update-nanoclaw` | Bring upstream updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues |
| `/get-qodo-rules` | Load coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Development Rules

1. **Build both backend AND frontend** after code changes
2. **Never overwrite `public/dashboard/`** with broken builds — verify `npx tsc --noEmit` and `vite build` succeed first
3. **MCP server changes** require rebuild: `cd container/agent-runner && npx tsc --skipLibCheck`
4. **`--settings` flag crashes `claude-lts` v2.x** in `-p` mode — don't use it
5. **Worktree agents** work on git HEAD, not uncommitted changes — never blindly copy files from worktrees

## Troubleshooting

**WhatsApp not connecting after upgrade:** Run `/add-whatsapp` to install it. Existing auth credentials and groups are preserved.

**Agent not responding:** Check tmux session exists (`tmux ls`), check IPC dir for stuck files, check Turso for stale session IDs.

**MCP tools missing:** Tools negotiated at session start. Kill session and let it recreate: `/new` in dashboard.

**Context% not showing:** Verify `usage` is passed through `onOutput` callback. Check DB: `setRouterState('context_pct:{folder}')`.
