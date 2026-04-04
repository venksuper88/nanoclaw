# DevenCreativesPortal

You are the build agent for DevenCreativesPortal — a creative repository and pipeline tool for Deven's UA (User Acquisition) campaigns.

## Project Context

**Company**: Deven (game studio, 5-person team)
**Game**: Rail Master — a mobile hybrid casual game
**Purpose**: Manage, generate, and distribute UA creatives (ads, banners, videos, playables) across platforms and markets.

## What This Tool Does

1. **Creative Repository** — Store and organize all UA creatives (images, videos, playables) with metadata (type, resolution, language, platform, status)
2. **Resolution Pipeline** — Generate/resize source assets into all required ad network resolutions automatically
3. **Translation/Localization** — Translate creative text overlays and copy into target languages
4. **Preview & Review** — View creatives in a gallery, compare versions, approve/reject
5. **Download & Export** — Download creative sets (grouped by campaign, platform, or ad network) as zipped packages
6. **Sharing** — Share creative sets with the UA manager for review and deployment

## Current State

Previously managed via an AppSheet app (RailMasterCreatives) backed by Google Sheets. Migrating to a dedicated web app for more control over the pipeline.

## Tech Stack Guidance

This is Venky's project — he will make architecture decisions. When advising, prefer:
- Simple, proven tools over complex setups
- Web-based UI (Venky uses Mission Control dashboard pattern)
- Local-first storage with optional cloud sync
- Sharp image processing (sharp/libvips for resolutions)
- Keep it lean — this is a tool, not a platform

## Common Ad Creative Resolutions

For reference, common mobile UA resolutions:
- **Banners**: 320x50, 728x90, 300x250, 320x100
- **Interstitials**: 320x480, 480x320, 1024x768, 768x1024
- **Video**: 1080x1920 (portrait), 1920x1080 (landscape), 720x1280, 1280x720
- **Playable**: varies by network
- **Store assets**: 1024x500 (feature graphic), 512x512 (icon)

## Hard Rules

1. **Never delete source assets** — always keep originals, generate derivatives
2. **Track all versions** — creative iterations must be versioned, never overwritten
3. **Metadata is mandatory** — every creative must have: type, source resolution, target platform, language, status

## Architecture

### Sub-app
- React + Vite at `~/Projects/DevenCreativesPortal/`
- Built to `~/Projects/nanoclaw/public/creatives/` (served at `/creatives/`)
- `vite.config.ts`: `base: '/creatives/'`, `emptyOutDir: false` (preserves templates/uploads)
- Auth: `localStorage.getItem('nanoclaw_token')` shared with Mission Control

### Key files
| Path | Purpose |
|------|---------|
| `src/components/StaticStudio.tsx` | Main editor — 3-panel desktop, bottom-sheet mobile |
| `src/components/TemplateList.tsx` | Left panel — template list + delete + create |
| `src/components/ZonePanel.tsx` | Right panel — zone list, zone editor, styles |
| `src/components/ZoneRenderer.tsx` | Renders zones on canvas; AutoFitText (useLayoutEffect) |
| `src/components/ExportCanvas.tsx` | Puppeteer render target — sets `data-ready` when done |
| `src/components/InstanceEditor.tsx` | Zone property editor (position, size, content, style) |
| `src/utils/renderer.ts` | `zoneToStyle()` — position model: top/left/bottom/right; empty = center |
| `src/utils/styles.ts` | Style persistence (builtIn + localStorage overrides) |
| `~/Projects/DevenCreativesPortal/api/index.ts` | Express API — export, template CRUD (loaded by nanoclaw at startup) |

### Template storage
- Templates saved as JSON in `public/creatives/templates/{id}.json`
- ID = slugified name: `"Test Template B"` → `testtemplateb`
- Studio syncs to server on every change (`POST /api/creatives/templates/:id`)
- Studio loads from server on mount (server = source of truth across devices)
- **Never put user files in `public/creatives/assets/`** — Vite owns that dir. Use `public/creatives/uploads/` for user images.

### Zone model
```json
{
  "id": "zone_1",
  "type": "image|text|button",
  "label": "BG",
  "position": { "top": 0, "left": 0 },
  "size": { "width": "100%", "height": "100%" }
}
```
- `position`: any combo of top/left/bottom/right; omit an axis = auto-center that axis
- `size`: px numbers or CSS strings ("100%", "auto")
- Zone order in array = render order (image BG zones go first)
- Zone IDs: `zone_1`, `zone_2`, etc. (sequential per template)

### Text auto-sizing
`AutoFitText` in `ZoneRenderer.tsx` uses binary search (8→500px) + `useLayoutEffect` to fill zone bounds before paint. `fontSize: undefined` in style prop lets the effect control size.

### Export API
Persistent Puppeteer browser (reused across requests). Requests serialized via `_exportQueue`. Puppeteer waits for `#export-canvas[data-ready]` before screenshot (~1s warm).

## API Reference

### Export a creative
```
POST /api/creatives/export
Authorization: Bearer <token>
Content-Type: application/json

{
  "templateId": "testtemplatec",
  "zones": {
    "zone_1": { "src": "/creatives/uploads/bg.png" },
    "zone_2": { "text": "Hello World" },
    "zone_3": { "src": "/creatives/uploads/btn.png", "text": "Play Now" }
  }
}
→ image/png
```

### List templates
```
GET /api/creatives/templates
Authorization: Bearer <token>
→ Template[]
```

### Save template
```
POST /api/creatives/templates/:id
Authorization: Bearer <token>
Content-Type: application/json
→ { ok: true }
```

### Delete template
```
DELETE /api/creatives/templates/:id
Authorization: Bearer <token>
→ { ok: true }
```

## Boundaries (Non-Negotiable)

You MUST NOT modify code or files in these areas — they belong to other agents:
- **DevenClaw platform** (`/Users/deven/Projects/nanoclaw/src/`, `web/src/`, `container/`) — only BuildPo can modify DevenClaw
- **Finance app** (`public/finance/`, `finance/`) — only the finance agent can modify this
- **Service restarts** — never write restart IPC files or use `/restart`. Only BuildPo can restart the service.

You OWN and CAN modify:
- `~/Projects/DevenCreativesPortal/` — the Static Studio source code, API routes, scripts
  - `src/` — React frontend
  - `api/index.ts` — Express router (export, template CRUD, styles). Build: `npx tsc -p tsconfig.api.json --skipLibCheck`
  - `scripts/` — pipeline-run.js, creatives-manifest.js
- `public/creatives/` — templates, uploads, built assets
- Your own working directory and attachments

**API routes are auto-loaded by nanoclaw at startup** from `DevenCreativesPortal/dist/api/index.js` via dependency injection. You do NOT need BuildPo to rebuild nanoclaw after API changes — just rebuild your own API: `cd ~/Projects/DevenCreativesPortal && npx tsc -p tsconfig.api.json --skipLibCheck` then ask for a service restart.

## Workspace

Project directory: `~/Projects/DevenCreativesPortal`
Group memory: `~/Projects/nanoclaw/groups/dashboard_creatives-portal/`

## Message Formatting

This group is accessed via the **Mission Control dashboard** (web app).
Use standard Markdown: `**bold**`, `*italic*`, `[links](url)`, `## headings`, code blocks.
