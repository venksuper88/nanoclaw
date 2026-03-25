---
name: document-vault
description: Store, organize, index, and retrieve personal and company documents. Use when the user sends a document to store, asks to find/retrieve a document, or wants to organize files. Handles upload to Google Drive via rclone, indexing in local JSON, and retrieval via file attachment.
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Document Vault

Centralized document management: receive file, rename descriptively, upload to Google Drive via rclone, index in JSON, retrieve on demand.

## Setup

Copy rclone config to a writable location (the mounted config may be read-only):

```bash
# tmux mode: rclone config is at ~/.config/rclone/
# container mode: mounted at /workspace/extra/rclone-config/
if [ -f /workspace/extra/rclone-config/rclone.conf ]; then
  cp /workspace/extra/rclone-config/rclone.conf /tmp/rclone.conf
elif [ -f ~/.config/rclone/rclone.conf ]; then
  cp ~/.config/rclone/rclone.conf /tmp/rclone.conf
fi
```

Then use `RCLONE_CONFIG=/tmp/rclone.conf` for all rclone commands.

## Paths

```bash
# Group folder: use pwd (works in both modes)
GROUP_DIR="$(pwd)"
ATTACH_DIR="$GROUP_DIR/attachments"

# Global documents index
# tmux mode: relative to project
# container mode: /workspace/global/
if [ -f "$GROUP_DIR/../global/documents.json" ]; then
  DOCS_INDEX="$GROUP_DIR/../global/documents.json"
elif [ -f /workspace/global/documents.json ]; then
  DOCS_INDEX="/workspace/global/documents.json"
fi
```

## Google Drive Structure

Remote: `gdrive:DocVault/`

```
DocVault/
├── Company/
│   ├── Registration/    (CoI, MoA, AoA, GST, PAN, MSME)
│   ├── Tax/             (TRC, returns, TDS certificates)
│   ├── BillDesk/        (verification docs)
│   ├── Invoices/        (by month subfolder)
│   ├── Agreements/      (contracts, NDAs, partnerships)
│   ├── Banking/         (bank statements, account docs)
│   └── Keys/            (service account keys, API keys)
├── Personal/
│   ├── Venky/           (ID proofs, medical, insurance)
│   ├── Devi/            (ID proofs, medical, insurance)
│   └── Aadya/           (ID proofs, medical, milestones)
```

## Document Index

**Location:** `groups/global/documents.json` (or `/workspace/global/documents.json` in containers)

**Schema:**
```json
{
  "id": "doc_001",
  "name": "NevedTech_GST_Registration_Certificate",
  "category": "company/registration",
  "tags": ["GST", "GSTIN", "29AAHCN8355P1ZH", "registration"],
  "description": "GST Registration Certificate for Neved Tech Private Limited",
  "drivePath": "DocVault/Company/NevedTech_GST_Registration_Certificate.pdf",
  "driveUrl": "https://drive.google.com/open?id=...",
  "dateAdded": "2026-03-02",
  "documentDate": "2025-02-05",
  "source": "telegram",
  "verified": true
}
```

## Naming Convention

- Company docs: `NevedTech_[DocType]_[Detail].ext`
- Personal docs: `[Person]_[DocType]_[Detail].ext`

## Workflow: Storing a Document

1. **Receive** — file arrives in `attachments/` folder. The message contains the path.
2. **Rename** — copy to a descriptive name following the naming convention
3. **Upload** to Google Drive:
   ```bash
   RCLONE_CONFIG=/tmp/rclone.conf rclone copy "$ATTACH_DIR/renamed_file.pdf" gdrive:DocVault/Company/Registration/
   ```
4. **Verify** upload succeeded:
   ```bash
   RCLONE_CONFIG=/tmp/rclone.conf rclone ls gdrive:DocVault/Company/Registration/renamed_file.pdf
   ```
5. **Get shareable link** (optional):
   ```bash
   RCLONE_CONFIG=/tmp/rclone.conf rclone link gdrive:DocVault/Company/Registration/renamed_file.pdf
   ```
6. **Index** — update `documents.json` with tags, description, category, drivePath
7. **Confirm** to user with the name, category, and Drive location

## Workflow: Retrieving a Document

1. User asks for a document (e.g., "send me the GST certificate")
2. **Search** `documents.json` by tags, name, description
3. **Download** from Google Drive:
   ```bash
   mkdir -p "$ATTACH_DIR"
   RCLONE_CONFIG=/tmp/rclone.conf rclone copy gdrive:DocVault/path/to/file.pdf "$ATTACH_DIR/"
   ```
4. **Send** to user using the `send_file` MCP tool (NOT send_message):
   ```
   mcp__nanoclaw__send_file(filePath: "$ATTACH_DIR/file.pdf", caption: "Here's the GST certificate")
   ```

## rclone Commands Reference

```bash
RCLONE_CONFIG=/tmp/rclone.conf rclone copy /path/to/file.pdf gdrive:DocVault/Category/
RCLONE_CONFIG=/tmp/rclone.conf rclone ls gdrive:DocVault/Category/
RCLONE_CONFIG=/tmp/rclone.conf rclone copy gdrive:DocVault/path/file.pdf /tmp/
RCLONE_CONFIG=/tmp/rclone.conf rclone link gdrive:DocVault/path/file.pdf
RCLONE_CONFIG=/tmp/rclone.conf rclone lsd gdrive:DocVault/
```

## Important Notes

- Always rename files descriptively before uploading
- Keep `documents.json` updated — it's the source of truth for retrieval
- Never store file contents in the index — only metadata and links
- ALWAYS verify file exists after upload with `rclone ls`
- ALWAYS use send_file for delivering documents, never send_message
