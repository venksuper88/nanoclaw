---
name: tenjin
description: Queries Tenjin UA analytics API — spend, revenue, ad revenue, cohort LTV, retention. Use when the user asks about UA performance, spend, ROAS, LTV, ad revenue, or install metrics for Rail Master.
---

# Tenjin API

## Auth

```bash
TOKEN=$(cat ~/.openclaw/secrets/tenjin_token)
curl -s -H "Authorization: Bearer $TOKEN" "https://api.tenjin.com/v2/..."
```

## App UUIDs

- **Android**: `424dabdf-07bc-407a-96e3-535f9452ab1e`
- **iOS**: `269513b7-b13c-4a65-afda-d674441685c5`

## Endpoints

Base: `https://api.tenjin.com/v2`

### /reports/spend

| Param | Required | Values |
|-------|----------|--------|
| start_date | yes | YYYY-MM-DD |
| end_date | yes | YYYY-MM-DD |
| group_by | yes | app, country, channel, site, creative, date |
| metrics | yes | comma-separated |
| granularity | yes | `totals-daily` or `daily` |

**Metrics**: installs, spend, cpi, total_rev, total_rev_Nd (N=0-120), rpu_Nd, pub_rev_Nd, roi_Nd, retention_Nd

- `total_rev` = actual revenue in reporting period
- `total_rev_30d` = cohort LTV for installs in that period

### /reports/ad_revenue

Same params. **Metrics**: ad_revenue, impressions, ecpm

## Gotchas

1. `group_by=app` already splits by platform — **never** use `group_by=app,platform`
2. `country=XX` param does NOT filter — returns all ~130 countries. Filter client-side.
3. Pagination: follow `links.next`, replace `http://` with `https://`
4. Max cohort window: D120 — D365 does not exist.

## Common Queries

**Monthly spend + revenue:**
```bash
TOKEN=$(cat ~/.openclaw/secrets/tenjin_token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.tenjin.com/v2/reports/spend?start_date=2026-02-01&end_date=2026-02-28&group_by=app&metrics=installs,spend,total_rev&granularity=totals-daily"
```

**Monthly ad revenue:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.tenjin.com/v2/reports/ad_revenue?start_date=2026-02-01&end_date=2026-02-28&group_by=app&metrics=ad_revenue,impressions&granularity=totals-daily"
```

**Country-level LTV cohort:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.tenjin.com/v2/reports/spend?start_date=2026-01-01&end_date=2026-02-28&group_by=country&metrics=installs,spend,total_rev_7d,total_rev_30d,rpu_30d&granularity=totals-daily"
```

## Full API Spec

Swagger reference: `~/clawd/skills/tenjin-finance/tenjin-api-swagger.json`
