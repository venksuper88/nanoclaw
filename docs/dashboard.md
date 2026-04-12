# Dashboard (Mission Control)

## Server (`src/dashboard/server.ts`)

Express.js + Socket.io on configurable port (default 5173). Mounts sub-apps (Finance, Creatives, Analytics).

## API Routes (`src/dashboard/routes.ts`)

| Prefix | Purpose |
|--------|---------|
| `/api/groups` | Register, list, manage group metadata |
| `/api/chat` | Message sending and thread management |
| `/api/sessions` | Session lifecycle (list, kill, interrupt) |
| `/api/tasks` | Scheduled tasks with pause/resume |
| `/api/todos` | Todo management with priority, dates, recurrence |
| `/api/notes` | Hierarchical notes, folders, audit, soft-delete |
| `/api/tokens` | Dashboard token CRUD (owner only) |
| `/api/mem0/*` | Memory service (search, create, delete scopes) |
| `/api/logs/:folder` | Streaming agent logs per group |
| `/api/claude-usage` | Token usage relay from Chrome extension |
| `/api/token-usage` | Analytics by group and session mode |
| `/api/status` | Uptime, counts, health |
| `/api/analytics` | Full group analytics |
| `/api/alerts` | Performance alerts |
| `/api/commands` | Autocomplete commands |

## Socket Events (`src/dashboard/events.ts`)

| Event | Purpose |
|-------|---------|
| `message:new` | New chat message |
| `agent:spawn/output/idle/exit/stuck/alert` | Agent lifecycle |
| `draft:update` | Draft message changes |
| `task:complete` | Scheduled task completion |
| `context:update` | Context% and KB size |
| `container:log` | Agent stdout/stderr |

## Auth (`src/dashboard/auth.ts`)

Bearer token in Authorization header or query param. Token properties:
- `role` (owner/user), `name`, `allowed_groups` (JID array)
- `can_send`, `is_owner`, `reminder_group_jid`
- Owner tokens bypass group filters; non-owner tokens filtered by `allowed_groups`

## Design System

| Element | Value |
|---------|-------|
| Heading font | Manrope, 800 weight, 22px |
| Body font | Inter |
| Primary color | `var(--purple)` #6C3CE1 |
| Background | Lavender #F3F0F8 |
| Surfaces | White |
| Corners | 1rem/16px rounded |
| Layout | Mobile-first, bottom tab bar, hamburger drawer |
| Icons | Material Symbols Outlined |
| Tabs | Chat, Overview, Tasks, Todos, Notes, Settings |

## Frontend (`web/src/`)

React SPA built with Vite. Components in `web/src/components/`:
- ChatView, OverviewView, TasksView, TodosView, NotesView, SettingsView

PWA with service workers, no-cache headers on index.html, immutable hashed assets.
