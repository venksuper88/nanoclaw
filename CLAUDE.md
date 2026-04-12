# DevenClaw

Personal AI assistant platform. Node.js + TypeScript. Runs Claude agents via persistent tmux sessions (`claude-lts -p`). Web dashboard at `mc.neved.in`.

## Quick Start

```bash
npm run dev            # Run with hot reload
npm run build          # Compile TypeScript (backend)
cd web && npm run build # Build React frontend
npx tsc --skipLibCheck  # Type-check only
```

## Usage Docs

Read these when you need to use a feature:

| Doc | When to read |
|-----|-------------|
| [docs/commands.md](docs/COMMANDS.md) | Creating commands, COMMAND.json spec, input/output, workflow commands |
| [docs/skills.md](docs/skills.md) | Skill types, sync mechanism, allowed_skills |
| [docs/tasks.md](docs/tasks.md) | Scheduled tasks, cron/interval/once, execution model |
| [docs/todos.md](docs/todos.md) | Todos, reminders, recurrence, daily digest |
| [docs/notes.md](docs/notes.md) | Notes system, folders, checklist items, FTS search |
| [docs/settings.md](docs/settings.md) | Group settings, token management, configuration |

## Rules

- **All dates MUST be stored in UTC ISO format** — timezone offset strings break comparisons
- **Never ship with TypeScript errors** — `--skipLibCheck` compiles broken JS that crashes at runtime. Run `npx tsc --noEmit --skipLibCheck` before any restart.
- **Never restart the service without asking Venky first** — other agents may be mid-task
- **Never auto-compact sessions without asking Venky first** — compaction loses context
- **After SendMessage, do NOT repeat the same info as plain text** — both get forwarded as duplicates
- **Never Read output images inline** — dumps full image data into context, spiking usage 60%+. Report results in text only.
- **Verify data claims before sharing** — query live state, don't cite stale numbers or extrapolate from other agents' contexts
- **Never blindly copy worktree files** — worktrees start from git HEAD, may be stale. Use `git diff` and selective edits, not `cp`.
- **Build long-term systems, not one-time fixes** — if a problem can recur, the fix should prevent recurrence automatically
- **Use LLM schema fields for enum extraction** (network keys, platforms, categories) — not regex post-processing on free text
- **Check path identity before rm+cp in sync logic** — dashboard groups without `workDir` have src === dst, causing ENOENT crash loops

## User Context

Venky is the studio lead at Neved Tech (Bengaluru). Game: Rail Master Tycoon (mobile). He exclusively uses Mission Control Dashboard (mc.neved.in) — never Telegram/WhatsApp. Prefers architecture-first design, expects agents to execute, not instruct.

## Agent Boundaries

- **BuildPo** — exclusive owner of DevenClaw platform code (`src/`, `web/src/`, `container/`). Only agent that can restart the service.
- **DevenAccountant** — owns `~/Projects/deven-finance/`. Does NOT touch `nanoclaw/src/`.
- **Harry** — read-only outside own dir. Cannot modify platform/creatives/finance code or restart.
- **RailMaster agents** — scoped to their respective project directories only.
- **Po** — delegates code changes, does not implement directly.

## Architecture

All agents run as tmux sessions via `claude-lts -p`. Container mode was removed Mar 2026. Skills sync every turn. MCP tools negotiated at session start (new tools need `/new`). `container/` directory only holds skills, commands, and MCP server source.

## Design System

- **Fonts:** Manrope (headings, 800 weight), Inter (body)
- **Colors:** `var(--purple)` #6C3CE1, lavender bg #F3F0F8, white surfaces — NOT `var(--accent)` (doesn't exist)
- **Style:** Rounded corners (1rem), pill badges, mobile-first
- **Icons:** Material Symbols Outlined
- **iOS PWA:** caches aggressively — close from app switcher to clear. `pre` needs `overflow-x: auto`. No `overflow-x: hidden` on html/body (breaks iOS keyboard).
