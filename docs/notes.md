# Notes System

## Data Model

### Tables

**notes** — Core notes with soft-delete
- `id`, `user_id`, `folder_id`, `title`, `content` (markdown), `tags` (comma-separated), `created_by`, `created_at`, `updated_at`, `deleted_at`

**notes_folders** — Nested folder organization
- `id`, `user_id`, `name`, `parent_id` (for nesting), `icon` (Material), `color` (hex), `sort_order`, `created_at`

**note_items** — First-class checklist items (separate from content)
- `id`, `note_id`, `title`, `status` (pending|done), `position`, `due_date`, `remind_at`, `recurrence`, `reminder_fired_at`, `created_at`, `updated_at`

**notes_audit** — Complete audit trail
- `id`, `note_id`, `action` (create/update/delete/restore), `actor`, `details`, `created_at`

**notes_fts** — Virtual FTS5 full-text search table with auto-sync triggers on title/content/tags

## API Routes

### Folders (`/api/notes/folders`)
- `GET` — list user folders
- `POST` — create (name, optional parent_id, icon, color, sort_order)
- `PATCH /:id` — update
- `DELETE /:id` — soft-delete (notes become unfiled, child folders re-parent)

### Notes (`/api/notes`)
- `GET` — list all, filter by `?folder=ID` or `?q=QUERY` (FTS5 search)
- `GET /trash` — list deleted notes
- `GET /:id` — read single note
- `POST` — create (title required; optional content, tags, folder_id, created_by). Deduplication (60s window). Auto-group-folder filing via `X-Group-Folder` header
- `PATCH /:id` — update (title, content, tags, folder_id). Auto-syncs checklist items from markdown
- `DELETE /:id` — soft-delete to trash
- `POST /:id/restore` — restore from trash
- `DELETE /:id/purge` — permanent deletion
- `GET /:id/audit` — audit log

### Checklist Items (`/api/notes/:noteId/items`)
- `GET` — list items
- `POST` — create item (title required)
- `PATCH /:itemId` — update status/due_date/remind_at/recurrence
- `DELETE /:itemId` — remove item

## Frontend (`web/src/components/NotesView.tsx`)

### Views
- **List view** — search bar, folder chips (hierarchical), trash toggle, FAB for new note
- **Read mode** — rendered HTML via `marked`, checklist component, tags, copy-link, edit button
- **Editor mode** — TipTap WYSIWYG with StarterKit, tables, markdown serialization, folder picker, live tag preview

### Features
- Auto-save on title/content/folder changes (800ms debounce)
- Folder nesting UI (indented child folders)
- Search: 300ms debounce, clears folder filter
- Checkbox counting in list view (done/total)
- Soft-delete with trash view (restore/purge)
- Markdown checkbox lines (`- [ ]`/`- [x]`) auto-create/update note_items

## Agent Skill (`container/skills/notes/SKILL.md`)

Agents access notes via REST API. Key behaviors:
- Auto-filing into agent's group folder via `X-Group-Folder` header
- Items are NOT in note content — use `/api/notes/NOTE_ID/items` endpoint directly
- Markdown checkboxes auto-sync to items on create/update
