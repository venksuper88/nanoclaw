# DevenClaw Design Brief — Sub-App Integration

This document defines the design system for building sub-apps (e.g., Finance) that integrate into the DevenClaw portal at `mc.neved.in`.

## Architecture

- Sub-app is a **separate project/repo** with its own stack
- Built to static files, served by DevenClaw's Express server under a path prefix (e.g., `/finance/`)
- DevenClaw sidebar links to the sub-app — **native navigation, no iframe**
- Same domain = shared auth (token in localStorage key `nanoclaw_token`)
- Sub-app is a full SPA with its own router, under the path prefix

## Serving

DevenClaw mounts sub-app static files in `src/dashboard/server.ts`. **Do NOT modify `server.ts` yourself** — ask BuildPo to wire it up. If you must reference the pattern, here's what the mount looks like:

```js
// CORRECT — relative path via process.cwd()
const APP_DIR = path.join(process.cwd(), 'public', 'myapp');
app.use('/myapp', express.static(APP_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.includes('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
// SPA fallback — required for client-side routing
app.get('/myapp/{*path}', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(APP_DIR, 'index.html'));
});
```

## Common Mistakes to Avoid

1. **Never hardcode absolute paths** — use `path.join(process.cwd(), ...)` or relative paths. Absolute paths like `/Users/deven/Projects/nanoclaw/public/finance` break portability.

2. **Always add SPA fallback route** — without it, direct navigation to sub-routes (e.g., `/finance/dashboard`) will 404 or serve DevenClaw's index.html instead of your app's. The fallback must be registered BEFORE DevenClaw's catch-all `/{*path}` route.

3. **Always set cache headers** — `index.html` must be `no-cache, no-store, must-revalidate` (iOS Safari PWA aggressively caches). Hashed assets in `/assets/` should be `immutable, max-age=31536000`.

4. **Never modify DevenClaw source files directly** — your app should only create files inside your own project directory (e.g., `finance/`). The Vite build output goes to `public/{appname}/`. Ask BuildPo to handle any server-side wiring.

5. **Set `base` in Vite config** — must match the path prefix:
   ```ts
   // vite.config.ts
   export default defineConfig({
     base: '/myapp/',           // MUST match the Express mount path
     build: { outDir: '../public/myapp' },
   });
   ```

## PWA Setup

```json
{
  "display": "standalone",
  "theme_color": "#6C3CE1",
  "background_color": "#F3F0F8"
}
```

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no, interactive-widget=resizes-content" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
```

## Fonts

```html
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
```

| Role | Font | Weights |
|------|------|---------|
| Headings/UI | Manrope | 600, 700, 800 |
| Body/Labels | Inter | 300, 400, 500, 600 |
| Code | JetBrains Mono / SF Mono | 400 |
| Icons | Material Symbols Outlined | variable |

## Color System

### Light Theme (default)

| Variable | Value | Usage |
|----------|-------|-------|
| `--bg` | #F3F0F8 | Page background |
| `--surface` | #FFFFFF | Cards, modals |
| `--surface-alt` | #EBE4F7 | Alt surface |
| `--input-bg` | #EBE4F7 | Input backgrounds |
| `--separator` | #D8D0E5 | Borders, dividers |
| `--text` | #2A2A3A | Primary text |
| `--text2` | #9A9AAA | Secondary text |
| `--text3` | #C8C8D0 | Hints, placeholders |
| `--purple` | #6C3CE1 | Primary accent |
| `--purple-light` | #E8E0F5 | Hover states |
| `--purple-pale` | #EEEAF5 | Selected states |
| `--purple-glow` | rgba(108,60,225,0.08) | Shadows |
| `--green` | #34C759 | Success |
| `--green-bg` | rgba(52,199,89,0.1) | Success bg |
| `--orange` | #FF9500 | Warning |
| `--orange-bg` | rgba(255,149,0,0.1) | Warning bg |
| `--error` | #FF3B30 | Error |
| `--error-bg` | rgba(255,59,48,0.08) | Error bg |

### Dark Theme

| Variable | Value |
|----------|-------|
| `--bg` | #18151F |
| `--surface` | #221E2B |
| `--surface-alt` | #2D2838 |
| `--purple` | #A78BFA |
| `--text` | #E8E4F0 |
| `--text2` | #8A8A9A |
| `--separator` | #3A3548 |

### Midnight Theme

| Variable | Value |
|----------|-------|
| `--bg` | #0C0A14 |
| `--surface` | #16131F |
| `--purple` | #B49AFF |

Use `[data-theme="dark"]` and `[data-theme="midnight"]` selectors on `:root`.

## Typography Scale

| Level | Font | Size | Weight | Usage |
|-------|------|------|--------|-------|
| Page Title | Manrope | 22px | 800 | Page headers |
| Section Title | Manrope | 18px | 800 | Section headers |
| Card Title | Manrope | 15-16px | 600-700 | Card headers |
| Large Stat | Manrope | 28px | 800 | Big numbers |
| Body | Inter | 14-15px | 400 | Content text |
| Label | Inter | 12-13px | 500-600 | Labels, secondary |
| Caption | Inter | 10-11px | 600 | Badges, timestamps |

## Spacing Scale (4px base)

| Token | Value |
|-------|-------|
| xs | 4px |
| sm | 8px |
| md | 12px |
| lg | 16px |
| xl | 20px |
| 2xl | 24px |
| 3xl | 32px |

## Border Radius

| Type | Value | Usage |
|------|-------|-------|
| Full | 9999px | Buttons, pills, badges, toggles |
| Large | 16px | Cards, drawers, modals |
| Medium | 12px | Inputs, chips |
| Small | 6-8px | Code blocks, small elements |

## Shadows

| Level | Value | Usage |
|-------|-------|-------|
| Card | 0 2px 8px rgba(0,0,0,0.03) | Cards |
| Floating | 0 4px 20px rgba(0,0,0,0.05) | Input bars |
| Button glow | 0 3px 10px rgba(108,60,225,0.3) | Primary buttons |
| Overlay | 0 -6px 24px rgba(0,0,0,0.06) | Menus |

## Components

### Cards
```css
background: var(--surface);
border-radius: 16px;
padding: 18px;
border: 1px solid var(--separator);
box-shadow: 0 2px 8px rgba(0,0,0,0.03);
```

### Buttons
```css
/* Base */
padding: 10px 20px;
border-radius: 9999px;
font-family: 'Inter';
font-size: 13px;
font-weight: 600;
transition: all 0.15s;

/* Primary */
background: var(--purple);
color: white;
box-shadow: 0 2px 8px rgba(108,60,225,0.2);

/* Outline */
background: var(--surface);
border: 1px solid var(--separator);
color: var(--purple);

/* Danger */
background: var(--error-bg);
color: var(--error);

/* Small */
padding: 6px 14px;
font-size: 11px;

/* Active state */
transform: scale(0.95);
```

### Badges
```css
padding: 3px 10px;
border-radius: 9999px;
font-size: 10px;
font-weight: 600;
letter-spacing: 0.3px;
/* Use --green-bg/--green, --orange-bg/--orange, --error-bg/--error, --purple-pale/--purple */
```

### Inputs
```css
padding: 8px 12px;
border: 1px solid var(--separator);
border-radius: 12px;
font-family: 'Inter';
font-size: 14px;
background: var(--bg);
color: var(--text);
/* Focus: border-color var(--purple) */
```

### Stat Cards
```css
/* 2-column grid, gap 10px */
padding: 20px 12px;
text-align: center;
/* Value: Manrope 28px 800 */
/* Label: uppercase 10px, letter-spacing 0.8px */
```

### Progress Bars
```css
/* Track */
height: 8px;
background: #f3f0f8;
border-radius: 4px;

/* Fill */
background: var(--purple);
border-radius: 4px;
transition: width 0.3s ease;
```

## Layout Structure

### App Shell
```
┌─────────────────────────────┐
│ Top Bar (52px)              │
├─────────────────────────────┤
│                             │
│ Main Content (flex: 1)      │
│ overflow-y: auto            │
│                             │
├─────────────────────────────┤
│ Bottom Tab Bar (58px)       │
│ + safe-area-inset-bottom    │
└─────────────────────────────┘
```

- Top bar: 52px height, surface bg, 1px border-bottom
- Content: flex 1, scrollable
- Bottom bar: fixed, 58px + safe area, 5 tabs with icons

### Sidebar Drawer (hamburger menu)
- Width: 75%, max-width 320px
- Slides from left, border-radius 0 20px 20px 0
- z-index 201, overlay at z-index 200

## Icons

Use Material Symbols Outlined:
```html
<span class="material-symbols-outlined">icon_name</span>
```

Or with CSS class shorthand:
```css
.mi { font-family: 'Material Symbols Outlined'; font-size: 22px; }
.mi-fill { font-variation-settings: 'FILL' 1; }
```

## Mobile Patterns

- Safe area insets for notch/home indicator
- Touch targets minimum 36x36px
- `-webkit-tap-highlight-color: transparent` on interactive elements
- Active state: `transform: scale(0.95)` or bg change
- `overscroll-behavior: none` to prevent bounce
- Viewport height: use `100dvh` (dynamic viewport height)

## Animations

| Element | Duration | Easing |
|---------|----------|--------|
| Buttons | 0.15s | ease |
| Drawer slide | 0.3s | cubic-bezier(0.2,0,0,1) |
| Tab icons | 0.25s | cubic-bezier(0.2,0,0,1) |
| Progress bars | 0.3s | ease |
| Dialogs | 0.2s | ease-out |

## Auth Integration

Sub-apps share the same origin as DevenClaw, so auth is simple:
```js
const token = localStorage.getItem('nanoclaw_token');
// Use for API calls:
fetch('/api/...', {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

The sub-app can also use DevenClaw's API endpoints directly (same origin, no CORS).

## Navigation Back to DevenClaw

Include a back/home link in the sub-app's top bar:
```html
<a href="/">← DevenClaw</a>
```

## Reference

The canonical design source is DevenClaw's stylesheet:
`/Users/deven/Projects/nanoclaw/web/src/styles.css`
