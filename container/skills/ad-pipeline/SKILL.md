---
name: ad-pipeline
description: Runs the ad creative export pipeline — syncs Drive Input/Assets, reads permutations from a Google Sheet, exports all combinations via the creatives API, and uploads results to Drive Output. Use when Devi asks to run the ad pipeline, export creatives, or generate ad images from a template.
---

# Ad Pipeline

Exports all ad creative permutations for a given template and uploads them to Drive.

## Command

```bash
cd /Users/deven/Projects/nanoclaw
source .env 2>/dev/null || export $(grep -v '^#' .env | xargs)
DASHBOARD_TOKEN=$DASHBOARD_TOKEN API_BASE=https://mc.neved.in \
  node scripts/pipeline-run.js <template_id> <sheet_gid>
```

## Parameters

| Param | Example | Notes |
|-------|---------|-------|
| `template_id` | `template_1775041946761` | The template name as shown in the dashboard |
| `sheet_gid` | `1778695435` | Google Sheet tab GID from the URL (`?gid=XXXXXX`) |

Sheet: `1Y27STGF8NllPUlQQrLAv17EotF_vd09IIVf3MUBKkLs`

## Drive Layout

- **Input** `gdrive:Devi/Ad Pipeline/Input` — BG images
- **Assets** `gdrive:Devi/Ad Pipeline/Assets` — shared assets (button, logo)
- **Output** `gdrive:Devi/Ad Pipeline/Output` — exports land here

## Workflow

1. Read `DASHBOARD_TOKEN` from `/Users/deven/Projects/nanoclaw/.env`
2. Run the command above with the provided `template_id` and `sheet_gid`
3. Report the summary (exported count, timing, file list) back to Devi
4. If any exports failed, report the error details

## Notes

- If Devi doesn't provide params, reuse the last known values (`template_1775041946761`, gid `1778695435`)
- The script exits non-zero if any exports fail — check the output for `✗` lines
