#!/bin/bash
DOCS_DIR="${NANOCLAW_PROJECT_ROOT}/docs"

if [ ! -d "$DOCS_DIR" ]; then
  echo '{"message": "No docs/ directory found"}'
  exit 0
fi

lines=""
count=0
for f in "$DOCS_DIR"/*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  size=$(ls -lh "$f" | awk '{print $5}')
  lines="${lines}${name}  (${size})\n"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo '{"message": "No .md files found in docs/"}'
  exit 0
fi

msg=$(printf "*Docs* — %d files\n\n%b" "$count" "$lines")
echo "{\"message\": $(echo "$msg" | jq -Rs .)}"
