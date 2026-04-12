# Overview Tab

Real-time monitoring of agent activity, token usage, and costs.

## Sections

### 1. Stats Cards
Top row: groups count, active tasks, active sessions, uptime. Source: `/api/status`.

### 2. Alerts
Up to 20 active performance alerts filtered by type:
- `slow_response` — agent took too long
- `high_turns` — too many turns in a session
- `high_cost` — expensive session
- `high_context` — context% above threshold

Dismissible individually or all at once.

**Data model** (`agent_alerts` table): id, group_folder, group_name, type, message, duration_ms, num_turns, cost_usd, context_percent, created_at, dismissed.

### 3. Claude Plan Usage
Session, weekly all-models, and weekly Sonnet-only usage percentages with reset countdowns. Data from Chrome extension via `/api/claude-usage`.

### 4. Token Usage
Aggregate tokens, cost, and turn counts across all groups for "This Week" or "Last Week" periods.

- Weekly reset: Thursday 00:00 UTC (`RESET_DAY = 4`)
- Boundaries calculated via `getWeekBoundaries()`
- Uses actual `cost_usd` when available; otherwise estimates via Sonnet 4 pricing

**Data model** (`token_usage` table aggregates): group_folder, total input/cache_creation/cache_read/output tokens, total_cost_usd, turn_count, stateful/stateless splits.

### 5. Stateful/Stateless Split
Token usage breakdown by session mode. Only shown when stateless_tokens > 0.

### 6. Agents List
Per-group metrics:
- Session status, last activity, message counts
- Context% (color-coded: >80% red, >50% orange)
- Transcript sizes, attachment folder sizes

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/status` | Uptime, group/task/session counts |
| `GET /api/analytics` | Full group analytics |
| `GET /api/token-usage?since=&until=` | Token usage summary per group |
| `GET /api/alerts` | Active alerts (up to 100) |
| `POST /api/alerts/:id/dismiss` | Dismiss single alert |
| `POST /api/alerts/dismiss-all` | Dismiss all alerts |
| `GET /api/claude-usage` | Claude plan usage data |
