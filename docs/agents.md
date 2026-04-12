# Agents & Groups

## Group Registration (`registered_groups` table)

### Core Fields
- `jid` (PK) — Chat platform identifier (e.g., `dash:po`, `tg:-1001234`)
- `folder` (UNIQUE) — Filesystem folder name
- `name` — Display name in sidebar
- `trigger_pattern` — Regex or exact trigger word
- `added_at` — ISO timestamp

### Behavior Fields
- `requires_trigger` — Default 1 (needs @mention); 0 = always listening
- `is_main` — Main control group (no trigger, elevated privileges)
- `is_transient` — Fresh session each trigger, closes after response
- `idle_timeout_minutes` — Custom timeout; NULL = default 30min; 0 = always on

### Memory & Scoping
- `memory_mode` — 'full' (mem0), 'local' (CLAUDE.md only), 'disabled'
- `memory_scopes` — JSON array of scope tags for shared memory access
- `memory_user_id` — mem0 userId for private isolation (supports comma-separated)

### Capability Control
- `allowed_skills` — JSON array of skill folders to load (empty = all)
- `allowed_mcp_servers` — JSON array from ~/.claude.json (empty = none; `['__all__']` = all)
- `disabled_tools` — JSON array of MCP tool names to disable

### Compute & Runtime
- `model` — 'opus' or 'sonnet' (default: opus)
- `context_window` — '200k' or '1m' (default: 200k)
- `work_dir` — Custom working directory for project-scoped agents
- `mode` — Always 'tmux'

### UI
- `show_in_sidebar` — Default 1; 0 = Settings-only visibility

## User Scoping

- `memory_user_id` isolates memories per user
- Shared memories under userId 'shared' with scope tags
- Owner groups see all; non-owners see private + whitelisted scopes

## Agent Boundaries

- Groups run in isolated tmux sessions with IPC via `data/ipc/{folder}/`
- File I/O constrained to `work_dir`
- `disabled_tools` stripped from agent manifest before execution
- Each agent's CLAUDE.md defines ownership rules (what code it can modify)

## Access Control

- Dashboard tokens control who views/sends to which groups
- Owner tokens (`is_owner=1`) bypass group filters
- Non-owner tokens filtered by `allowed_groups` whitelist
