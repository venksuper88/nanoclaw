---
name: applovin
description: Queries AppLovin MAX Revenue Reporting API — ad revenue by network, platform, country, ad format. Use when the user asks about AppLovin MAX ad revenue, mediation revenue, network breakdown, ad source performance, or wants to verify/compare MAX revenue against Tenjin.
---

# AppLovin MAX Revenue Reporting API

## Auth

API key for Rail Master: `8H9Z1GDVyuJFlFSPRFGJ2dfrpXHmn5cEJ1xQ1C65taHoepfT92Lxbh39n3nR3fxZxihdkWJoihc8OKsA6TmWw1`

Also stored in env as `APPLOVIN_REPORT_KEY`. If neither is set, ask the user.

```bash
KEY="${APPLOVIN_REPORT_KEY:-ASK_USER}"
curl -s "https://r.applovin.com/maxReport?api_key=$KEY&..."
```

## Endpoint

```
GET https://r.applovin.com/maxReport
```

All parameters are query string params. No request body, no separate auth header.

## Key Parameters

| Param | Required | Values |
|-------|----------|--------|
| api_key | yes | Your MAX reporting API key |
| start | yes | YYYY-MM-DD |
| end | yes | YYYY-MM-DD |
| format | yes | `json` or `csv` |
| columns | yes | comma-separated column names |
| filter_* | no | e.g. `filter_platform=android` |
| sort_* | no | e.g. `sort_estimated_revenue=DESC` |

**Max date window: 45 days per request.** For multi-month queries, loop in 45-day chunks.

## Key Columns

| Column | Description |
|--------|-------------|
| day | Date (YYYY-MM-DD) |
| platform | `android` or `ios` |
| network | Ad network / mediation source (Google, Meta, AppLovin, Unity, etc.) |
| ad_format | `Banner`, `Interstitial`, `Rewarded`, etc. |
| country | ISO 2-letter country code |
| impressions | Number of ad impressions |
| estimated_revenue | Revenue in USD (float) |
| ecpm | Effective CPM in USD |
| package_name | App bundle ID |
| application | App name |

## Common Queries

**Network breakdown (primary use case — verify MAX mediation by ad source):**
```bash
KEY="${APPLOVIN_REPORT_KEY}"
curl -s "https://r.applovin.com/maxReport?api_key=$KEY&start=2026-02-01&end=2026-02-28&format=json&columns=day,network,impressions,estimated_revenue,ecpm&sort_estimated_revenue=DESC"
```

**Monthly revenue summary by platform:**
```bash
curl -s "https://r.applovin.com/maxReport?api_key=$KEY&start=2026-02-01&end=2026-02-28&format=json&columns=day,platform,impressions,estimated_revenue,ecpm"
```

**Platform split per network (android vs iOS per ad source):**
```bash
curl -s "https://r.applovin.com/maxReport?api_key=$KEY&start=2026-02-01&end=2026-02-28&format=json&columns=day,platform,network,impressions,estimated_revenue,ecpm&sort_estimated_revenue=DESC"
```

**Filter to a single platform:**
```bash
curl -s "https://r.applovin.com/maxReport?api_key=$KEY&start=2026-02-01&end=2026-02-28&format=json&columns=day,network,impressions,estimated_revenue,ecpm&filter_platform=android"
```

**Multi-month query (loop in 45-day chunks):**
```bash
# Chunk 1: Jan 1 – Feb 14
curl -s "https://r.applovin.com/maxReport?api_key=$KEY&start=2026-01-01&end=2026-02-14&format=json&columns=day,network,estimated_revenue"

# Chunk 2: Feb 15 – Mar 31
curl -s "https://r.applovin.com/maxReport?api_key=$KEY&start=2026-02-15&end=2026-03-31&format=json&columns=day,network,estimated_revenue"
```

## Interpreting Results

- `estimated_revenue` is in **USD**. Sum across rows to get total revenue for the period.
- `ecpm` is per-network effective CPM — useful for comparing fill quality across networks.
- Responses are JSON arrays under a `results` key, e.g.:
  ```json
  { "results": [ { "day": "2026-02-01", "network": "Google", "estimated_revenue": 123.45, ... }, ... ] }
  ```
- To get total revenue: sum all `estimated_revenue` values across rows.
- To compare with Tenjin: sum AppLovin MAX `estimated_revenue` across all networks — this should match Tenjin's `ad_revenue` metric for the same app/period.

## Gotchas

1. **45-day max window** — requests spanning more than 45 days return an error. Split into chunks. **Historical data beyond 45 days is permanently inaccessible.**
2. **`month` is not a valid column** — use `day` and aggregate in Python/JS.
3. **`estimated_revenue` is an estimate** — final payouts may differ slightly. Tenjin also reports estimates, so comparison is valid. Expect ~10–15% variance.
4. **`network` values** are internal codes like `APPLOVIN_NETWORK`, `ADMOB_BIDDING`, `FACEBOOK_NETWORK`, `UNITY_BIDDING`, `MINTEGRAL_BIDDING`, `IRONSOURCE_BIDDING`, `YANDEX_BIDDING`. Map them to readable names when displaying.
5. **Applovin is the mediator** — all ad networks (Google, Meta, Unity, etc.) route through MAX, so the total across all networks = total mediation ad revenue.
4. **Date params are inclusive** on both ends.
5. **No pagination** — all matching rows are returned in one response (keep columns minimal for large queries).
