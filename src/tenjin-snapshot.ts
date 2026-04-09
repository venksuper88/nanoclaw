/**
 * Fetches Tenjin monthly data and stores it in the tenjin_snapshots table.
 * Shared between routes.ts (manual refresh) and task-scheduler.ts (daily cron).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDbClient } from './db.js';

export interface TenjinSnapshot {
  month: string;
  android_total_rev: number;
  ios_total_rev: number;
  android_ad_rev: number;
  ios_ad_rev: number;
  total_rev: number;
  ad_rev: number;
  iap: number;
  spend_by_channel: Record<string, number>;
  ad_rev_by_network: Record<string, number>;
  fetched_at: string;
}

export async function getAllTenjinSnapshots(): Promise<TenjinSnapshot[]> {
  const r = await getDbClient().execute(
    `SELECT * FROM tenjin_snapshots ORDER BY month`,
  );
  return r.rows.map((row) => ({
    month: row.month as string,
    android_total_rev: Number(row.android_total_rev),
    ios_total_rev: Number(row.ios_total_rev),
    android_ad_rev: Number(row.android_ad_rev),
    ios_ad_rev: Number(row.ios_ad_rev),
    total_rev: Number(row.total_rev),
    ad_rev: Number(row.ad_rev),
    iap: Number(row.iap),
    spend_by_channel: JSON.parse((row.spend_by_channel as string) || '{}'),
    ad_rev_by_network: JSON.parse((row.ad_rev_by_network as string) || '{}'),
    fetched_at: row.fetched_at as string,
  }));
}

export async function getTenjinSnapshot(
  month: string,
): Promise<TenjinSnapshot | null> {
  const r = await getDbClient().execute({
    sql: `SELECT * FROM tenjin_snapshots WHERE month = ?`,
    args: [month],
  });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    month: row.month as string,
    android_total_rev: Number(row.android_total_rev),
    ios_total_rev: Number(row.ios_total_rev),
    android_ad_rev: Number(row.android_ad_rev),
    ios_ad_rev: Number(row.ios_ad_rev),
    total_rev: Number(row.total_rev),
    ad_rev: Number(row.ad_rev),
    iap: Number(row.iap),
    spend_by_channel: JSON.parse((row.spend_by_channel as string) || '{}'),
    ad_rev_by_network: JSON.parse((row.ad_rev_by_network as string) || '{}'),
    fetched_at: row.fetched_at as string,
  };
}

export async function fetchAndStoreTenjinSnapshot(
  month: string,
): Promise<TenjinSnapshot> {
  const tokenPath = path.join(os.homedir(), '.openclaw/secrets/tenjin_token');
  if (!fs.existsSync(tokenPath)) throw new Error('Tenjin token not found');
  const token = fs.readFileSync(tokenPath, 'utf-8').trim();

  const [y, m] = month.split('-');
  const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
  const start = `${month}-01`;
  const end = `${month}-${String(lastDay).padStart(2, '0')}`;
  const base = 'https://api.tenjin.com/v2';
  const headers = { Authorization: `Bearer ${token}` };

  const APPLOVIN_KEY =
    '8H9Z1GDVyuJFlFSPRFGJ2dfrpXHmn5cEJ1xQ1C65taHoepfT92Lxbh39n3nR3fxZxihdkWJoihc8OKsA6TmWw1';

  const [spendRes, totalRevRes, adrevRes, maxRes] = await Promise.all([
    fetch(
      `${base}/reports/spend?start_date=${start}&end_date=${end}&group_by=channel&metrics=installs,spend&granularity=totals-daily`,
      { headers },
    ),
    fetch(
      `${base}/reports/spend?start_date=${start}&end_date=${end}&group_by=app&metrics=revenue,total_rev&granularity=totals-daily`,
      { headers },
    ),
    fetch(
      `${base}/reports/ad_revenue?start_date=${start}&end_date=${end}&group_by=app&metrics=ad_revenue&granularity=totals-daily`,
      { headers },
    ),
    fetch(
      `https://r.applovin.com/maxReport?api_key=${APPLOVIN_KEY}&start=${start}&end=${end}&format=json&columns=day,platform,network,estimated_revenue`,
    ),
  ]);

  const spendData: any = await spendRes.json();
  const totalRevData: any = await totalRevRes.json();
  const adrevData: any = await adrevRes.json();
  const maxData: any = await maxRes.json().catch(() => ({ results: [] }));

  // Spend by channel
  const channelMap: Record<string, number> = {};
  for (const row of spendData.data || []) {
    const attrs = row.attributes || {};
    const sid = (attrs.short_id || attrs.name || '').toLowerCase();
    const key =
      sid === 'google' || sid === 'google_search'
        ? 'google_ads'
        : sid === 'facebook'
          ? 'meta'
          : sid === 'applifier' || sid.includes('unity')
            ? 'unity'
            : sid === 'mintegral'
              ? 'mintegral'
              : null;
    if (key && attrs.spend)
      channelMap[key] = (channelMap[key] || 0) + (Number(attrs.spend) || 0);
  }

  // Total revenue per platform
  let androidTotalRev = 0,
    iosTotalRev = 0;
  for (const row of totalRevData.data || []) {
    const attrs = row.attributes || {};
    const rev = Number(attrs.total_rev) || 0;
    if (attrs.platform === 'android') androidTotalRev += rev;
    else if (attrs.platform === 'ios') iosTotalRev += rev;
  }

  // Ad revenue per platform
  let androidAdRev = 0,
    iosAdRev = 0;
  for (const row of adrevData.data || []) {
    const attrs = row.attributes || {};
    const rev = Number(attrs.ad_revenue) || 0;
    if (attrs.platform === 'android') androidAdRev += rev;
    else if (attrs.platform === 'ios') iosAdRev += rev;
  }

  const totalRev = androidTotalRev + iosTotalRev;
  const adRev = androidAdRev + iosAdRev;
  const iap = Math.max(0, totalRev - adRev);
  const fetched_at = new Date().toISOString();

  // AppLovin MAX per-network ad revenue
  const networkMap: Record<string, number> = {};
  const NETWORK_NAMES: Record<string, string> = {
    APPLOVIN_NETWORK: 'AppLovin',
    GOOGLE: 'Google AdMob',
    FACEBOOK: 'Meta',
    UNITY_ADS: 'Unity',
    MINTEGRAL: 'Mintegral',
    IRONSOURCE: 'IronSource',
    VUNGLE: 'Liftoff',
    CHARTBOOST: 'Chartboost',
    INMOBI: 'InMobi',
    SMAATO: 'Smaato',
    YANDEX: 'Yandex',
    MYTARGET: 'MyTarget',
  };
  // Canonical key map: AppLovin MAX display name → revenue_monthly source_key
  // Covers both legacy display names and new API identifiers (with bidding suffixes)
  const NETWORK_TO_KEY: Record<string, string> = {
    // Legacy display names
    'AppLovin': 'applovin', 'Google AdMob': 'google_adrev', 'Meta': 'meta',
    'Unity': 'unity', 'Mintegral': 'mintegral', 'IronSource': 'ironsource',
    'Yandex': 'yandex', 'Liftoff': 'ironsource',
    // New API identifiers
    'APPLOVIN_NETWORK': 'applovin', 'APPLOVIN_EXCHANGE': 'applovin',
    'GOOGLE': 'google_adrev', 'ADMOB_BIDDING': 'google_adrev',
    'FACEBOOK': 'meta', 'FACEBOOK_NETWORK': 'meta',
    'UNITY_ADS': 'unity', 'UNITY_BIDDING': 'unity',
    'MINTEGRAL': 'mintegral', 'MINTEGRAL_BIDDING': 'mintegral',
    'IRONSOURCE': 'ironsource', 'IRONSOURCE_BIDDING': 'ironsource',
    'YANDEX': 'yandex', 'YANDEX_BIDDING': 'yandex',
    'VUNGLE': 'ironsource',
  };
  const LAG_DAYS: Record<string, number> = {
    google_play: 30, apple: 45, applovin: 30, google_adrev: 30,
    meta: 30, unity: 50, mintegral: 45, ironsource: 60, yandex: 45,
  };
  for (const row of maxData.results || []) {
    const net = row.network || 'Other';
    const displayName = NETWORK_NAMES[net] || net;
    const rev = Number(row.estimated_revenue) || 0;
    networkMap[displayName] = (networkMap[displayName] || 0) + rev;
  }

  // Build canonical aggregated map for revenue_monthly upsert
  const canonicalMap: Record<string, number> = {};
  for (const [displayName, rev] of Object.entries(networkMap)) {
    const key = NETWORK_TO_KEY[displayName];
    if (key) canonicalMap[key] = (canonicalMap[key] || 0) + rev;
  }

  await getDbClient().execute({
    sql: `INSERT OR REPLACE INTO tenjin_snapshots
          (month, android_total_rev, ios_total_rev, android_ad_rev, ios_ad_rev,
           total_rev, ad_rev, iap, spend_by_channel, ad_rev_by_network, fetched_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      month,
      androidTotalRev,
      iosTotalRev,
      androidAdRev,
      iosAdRev,
      totalRev,
      adRev,
      iap,
      JSON.stringify(channelMap),
      JSON.stringify(networkMap),
      fetched_at,
    ],
  });

  // Upsert expected_usd into revenue_monthly (single source of truth for reconciliation)
  await getDbClient().execute(`
    CREATE TABLE IF NOT EXISTS revenue_monthly (
      source_key TEXT NOT NULL, month TEXT NOT NULL,
      expected_usd REAL NOT NULL DEFAULT 0, received_usd REAL NOT NULL DEFAULT 0,
      lag_days INTEGER NOT NULL DEFAULT 30, received_date TEXT,
      PRIMARY KEY (source_key, month)
    )
  `);
  const androidIAP = Math.max(0, androidTotalRev - androidAdRev);
  const iosIAP     = Math.max(0, iosTotalRev - iosAdRev);
  const iapUpserts: Array<[string, number]> = [
    ['google_play', androidIAP],
    ['apple',       iosIAP],
  ];
  for (const [key, exp] of iapUpserts) {
    await getDbClient().execute({
      sql: `INSERT INTO revenue_monthly (source_key, month, expected_usd, lag_days)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(source_key, month) DO UPDATE SET expected_usd=excluded.expected_usd`,
      args: [key, month, exp, LAG_DAYS[key] ?? 30],
    });
  }
  for (const [key, exp] of Object.entries(canonicalMap)) {
    if (exp <= 0) continue;
    await getDbClient().execute({
      sql: `INSERT INTO revenue_monthly (source_key, month, expected_usd, lag_days)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(source_key, month) DO UPDATE SET expected_usd=excluded.expected_usd`,
      args: [key, month, Math.round(exp * 100) / 100, LAG_DAYS[key] ?? 45],
    });
  }

  return {
    month,
    android_total_rev: androidTotalRev,
    ios_total_rev: iosTotalRev,
    android_ad_rev: androidAdRev,
    ios_ad_rev: iosAdRev,
    total_rev: totalRev,
    ad_rev: adRev,
    iap,
    spend_by_channel: channelMap,
    ad_rev_by_network: networkMap,
    fetched_at,
  };
}
