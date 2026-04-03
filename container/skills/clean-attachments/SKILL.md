---
name: clean-attachments
description: Delete all attachments in this group's attachments folder to free disk space. Use when the user asks to clean up, clear, or remove attachments.
---

# /clean-attachments — Clean Group Attachments

Deletes all files in the current group's attachments folder.

## How to clean

```bash
ATTACHMENTS_DIR="${NANOCLAW_ATTACHMENTS_DIR:-groups/$(basename $PWD)/attachments}"

if [ -d "$ATTACHMENTS_DIR" ]; then
  COUNT=$(find "$ATTACHMENTS_DIR" -type f | wc -l | tr -d ' ')
  SIZE=$(du -sh "$ATTACHMENTS_DIR" 2>/dev/null | cut -f1)
  rm -rf "$ATTACHMENTS_DIR"/*
  echo "Deleted $COUNT files ($SIZE)"
else
  echo "No attachments directory found"
fi
```

Then respond with how many files and how much space was freed.

**Note:** This only clears attachments for the current group — other groups are not affected.
