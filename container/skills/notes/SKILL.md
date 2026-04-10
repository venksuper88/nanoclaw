---
name: notes
description: Create, read, update, search, and organize notes with folders. Notes persist across sessions and are visible in the Notes tab of Mission Control.
---

# Notes

Manage user notes via the DevenClaw API. Notes support markdown content, tags, full-text search, nested folders, soft-delete with trash, and audit logging.

## Authentication

All requests require a Bearer token. Always set the group folder header for proper note filing:

```bash
AUTH="Authorization: Bearer $NANOCLAW_API_TOKEN"
GRP="X-Group-Folder: $NANOCLAW_GROUP_FOLDER"
API="$NANOCLAW_API_URL"
```

## Folders

### List folders
```bash
curl -s -H "$AUTH" "$API/api/notes/folders" | jq '.data'
```

### Create folder
```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$API/api/notes/folders" \
  -d '{"name": "Meeting Notes", "icon": "groups", "color": "#6C3CE1"}'
```
Optional fields: `parent_id` (for nesting), `icon` (Material icon name), `color` (hex), `sort_order` (int).

### Update folder
```bash
curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  "$API/api/notes/folders/FOLDER_ID" \
  -d '{"name": "New Name", "color": "#FF5733"}'
```

### Delete folder
```bash
curl -s -X DELETE -H "$AUTH" "$API/api/notes/folders/FOLDER_ID"
```
Notes in the folder become unfiled. Child folders re-parent to the deleted folder's parent.

## Notes

### List all notes
```bash
curl -s -H "$AUTH" "$API/api/notes" | jq '.data'
```

### List notes in a folder
```bash
curl -s -H "$AUTH" "$API/api/notes?folder=FOLDER_ID" | jq '.data'
```

### Search notes (FTS5 full-text search)
```bash
curl -s -H "$AUTH" "$API/api/notes?q=SEARCH_QUERY" | jq '.data'
```
Supports: word matching, phrases (`"meeting notes"`), prefixes (`meet*`), boolean (`meeting AND project`).

### Read a note
```bash
curl -s -H "$AUTH" "$API/api/notes/NOTE_ID" | jq '.data'
```

### Create a note
```bash
curl -s -X POST -H "$AUTH" -H "$GRP" -H "Content-Type: application/json" \
  "$API/api/notes" \
  -d '{"title": "Meeting Notes", "content": "# Agenda\n\n- Item 1", "tags": "meeting,weekly"}'
```
Required: `title`. Optional: `content` (markdown), `tags` (comma-separated), `folder_id`, `created_by`.

The `X-Group-Folder` header (set via `$GRP`) auto-creates a folder for your agent group and files notes there. You can also pass `created_by` in the body explicitly.

### Update a note
```bash
curl -s -X PATCH -H "$AUTH" -H "$GRP" -H "Content-Type: application/json" \
  "$API/api/notes/NOTE_ID" \
  -d '{"content": "Updated content"}'
```
Any combination of: `title`, `content`, `tags`, `folder_id`. The `X-Group-Folder` header provides the audit trail automatically.

### Delete a note (moves to trash)
```bash
curl -s -X DELETE -H "$AUTH" "$API/api/notes/NOTE_ID?actor=$NANOCLAW_GROUP_FOLDER"
```
Notes are soft-deleted (moved to trash). They can be restored from the Notes tab.

### Restore a note from trash
```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$API/api/notes/NOTE_ID/restore" -d '{}'
```

### View audit log
```bash
curl -s -H "$AUTH" "$API/api/notes/NOTE_ID/audit" | jq '.data'
```
Shows create, update, delete, and restore history with actor and timestamp.

## Permanent Links

Every note has a permanent link via its ID:
```
$NANOCLAW_API_URL/api/notes/NOTE_ID?token=$NANOCLAW_API_TOKEN
```
Use this to reference notes in messages, other notes, or agent conversations. The ID is returned when creating or listing notes.

## When to Use

- **Meeting notes** — summarize discussions, decisions, action items
- **Research findings** — save analysis results for future reference
- **Project summaries** — document architecture decisions, trade-offs
- **User requests** — "save this as a note" or "write this up"
- Any output the user might want to reference later
- **Proactively ask** — when producing long-form output, ask the user if they'd like it saved as a note

## Tips

- Always pass `created_by` / `updated_by` with your group folder for proper audit trail
- Notes without `folder_id` from agents auto-file into a per-agent group folder
- Always set `tags` for discoverability
- Content supports full markdown (headings, lists, code blocks, tables)
- Search is word-based, not substring — use specific terms
- When referencing a note, include its ID so others can fetch it
- Deletes go to trash — data is never permanently lost unless purged from the UI
