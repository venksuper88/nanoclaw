---
name: rail-master-pl
description: Rail Master Tycoon P&L workflow — rebuild the monthly P&L, query Tenjin/Applovin for UA and ad revenue data, upload to Google Drive. Use when asked to update the P&L, add a new month, reconcile UA spend, or share the Drive link.
---

# Rail Master Tycoon — P&L Workflow

**Reporting period:** Sep 2025 – present
**Company:** Neved Tech Private Limited
**Drive link:** https://drive.google.com/open?id=1cDPSlFz3JwM9CI_RupRwY3ejoB7WodV1D947ZCoR7Lw

---

## 1. Rebuild and Upload P&L

```bash
cd /Users/deven/Projects/nanoclaw/groups/dashboard_po
/Users/deven/opt/anaconda3/bin/python3 build_pl.py
```

On success, upload to Google Drive:

```bash
rclone copy /Users/deven/Projects/nanoclaw/groups/dashboard_po/RailMaster_PL.xlsx \
  "gdrive:RailMaster/" --drive-import-formats xlsx
```

Share the Drive link: https://drive.google.com/open?id=1cDPSlFz3JwM9CI_RupRwY3ejoB7WodV1D947ZCoR7Lw

---

## 2. Monthly Update Checklist

When a new month closes, update these dicts at the top of `build_pl.py`:

| Data | Dict to update | Source |
|------|---------------|--------|
| UA spend by channel | `tenjin_by_channel` | Tenjin `/v2/reports/spend?group_by=channel` (see §3) |
| Google Ads invoices | `gads_inr` | PDFs in Downloads / Google Payments portal |
| Meta invoices | `meta_inr` | Meta Business Manager invoices (ex-IGST INR) |
| Unity UA spend | `unity_usd` | Unity dashboard (USD, no IGST) |
| Ad revenue | `ad_revenue` | Tenjin `/v2/reports/ad_revenue` or Applovin MAX (see §4) |
| Total revenue | `total_rev` | Tenjin `/v2/reports/spend` total (IAP + ad rev) |
| Applovin by-network | `applovin_by_network` | Applovin MAX API (see §4) |
| BD developer salary | `eefc_bd_salary` | EEFC bank statement (USD, first IWRM outward each month) |
| EEFC other payments | `eefc_other_usd` | EEFC statement (Tenjin sub, Mintegral UA, Social Peta) |
| CC tools | `cc_tools_inr` | Credit card statement (Anthropic, Fly.io, Neon, Google Cloud, Workspace) |
| INR/USD rate | `INR_USD` | Mid-market rate for the month |

After updating all dicts, re-run `build_pl.py` and re-upload.

---

## 3. Tenjin UA Spend by Channel (Authoritative for P&L)

Tenjin data is the **authoritative source** for UA spend in the P&L (accrual USD, avoids IGST complications). Invoice data is used only for cash flow / reconciliation reference.

**Always use Node.js** — curl/Python fail to resolve the Tenjin hostname.

```js
// query_tenjin_spend.js — run with: node query_tenjin_spend.js
const fs = require('fs');
const token = fs.readFileSync('/Users/deven/.openclaw/secrets/tenjin_token', 'utf8').trim();

async function queryMonth(startDate, endDate) {
  const url = `https://api.tenjin.com/v2/reports/spend?` +
    `date_range_start=${startDate}&date_range_end=${endDate}&group_by=channel`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  const rows = json.data || [];
  const totals = {};
  for (const row of rows) {
    const ch = row.attributes.name;
    const sp = parseFloat(row.attributes.spend || 0);
    totals[ch] = (totals[ch] || 0) + sp;
  }
  return totals;
}

// Example: query March 2026
queryMonth('2026-03-01', '2026-03-31').then(console.log);
```

Expected channels: `Google Ads`, `Meta`, `Unity Ads`, `Mintegral`

**Note:** Oct iOS spend returned null from Tenjin — treat as 0.

---

## 4. Applovin MAX Ad Revenue by Network

See the `applovin` skill for full API docs. Quick reference:

```bash
KEY="8H9Z1GDVyuJFlFSPRFGJ2dfrpXHmn5cEJ1xQ1C65taHoepfT92Lxbh39n3nR3fxZxihdkWJoihc8OKsA6TmWw1"
curl -s "https://r.applovin.com/maxReport?api_key=$KEY&start=2026-03-01&end=2026-03-31&format=json&columns=day,network,impressions,estimated_revenue,ecpm&sort_estimated_revenue=DESC"
```

**45-day lookback limit** — historical data beyond 45 days is permanently inaccessible. Always pull Applovin data before the 45-day window closes.

Network code → readable name mapping:
| API code | Display name |
|----------|-------------|
| `APPLOVIN_NETWORK` | AppLovin |
| `ADMOB_BIDDING` | Google AdMob |
| `FACEBOOK_NETWORK` | Meta |
| `UNITY_BIDDING` | Unity |
| `MINTEGRAL_BIDDING` | Mintegral |
| `IRONSOURCE_BIDDING` | IronSource |
| `YANDEX_BIDDING` | Yandex |

Aggregate daily rows by network to get monthly totals. Sum all networks = total mediation ad revenue (should be within 1–3% of Tenjin ad_revenue).

---

## 5. Bank Statement Parsing

```bash
cd /Users/deven/Projects/nanoclaw/groups/dashboard_po
/Users/deven/opt/anaconda3/bin/python3 parse_bank.py
```

Parses IDFC First Bank PDF statements (INR current account + EEFC USD account) using pdfplumber.
Place PDFs in the working directory before running.

---

## 6. IGST / RCM Notes

- **Google Ads** and **Meta** India invoices include 18% IGST recoverable via Reverse Charge Mechanism (RCM). Invoice amount = ex-IGST spend.
- **Unity** invoices have no IGST.
- P&L uses ex-IGST amounts for all UA spend.
- Pending RCM IGST claim: ~₹2–3L across the reporting period — flag to CA.

---

## 7. Key Data Notes

- **Nov/Dec Meta discrepancy**: Tenjin reports ~2.5× higher than Meta invoices for Nov/Dec 2025. Possible second Meta ad account. Unresolved — P&L uses Tenjin (authoritative).
- **Google Play payouts**: Processed via IndiaIdeas.com Limited → NEFT/RTGS to IDFC First INR account.
- **EEFC inward remittances**: Sep–Dec senders unnamed in bank statements; Jan+ named (Google Asia Pacific, Meta Platforms Ireland, AppLovin Corporation, Apple Inc, Unity Technologies SF, Voodoo).
- **INR/USD rates**: Sep 83.8 | Oct 84.1 | Nov 84.4 | Dec 84.9 | Jan 86.5 | Feb 87.0 | Mar 87.0
