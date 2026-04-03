import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Group, Status } from '../App';

interface Props {
  groups: Group[];
  status: Status | null;
  processingFolders: Set<string>;
  onSelectGroup: (jid: string) => void;
  onRefresh: () => void;
}

interface Analytics {
  groups: Array<{
    jid: string;
    name: string;
    folder: string;
    channel: string;
    totalMessages: number;
    userMessages: number;
    botMessages: number;
    hasSession: boolean;
    lastActivity: string;
    transcriptSize: number;
    currentTranscriptSize: number;
    contextPercent: number;
    attachmentSize: number;
  }>;
  totalGroups: number;
  totalTasks: number;
  activeTasks: number;
  totalSessions: number;
}

interface TokenUsage {
  group_folder: string;
  total_input: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_output: number;
  total_tokens: number;
  turn_count: number;
  stateful_tokens: number;
  stateless_tokens: number;
  stateful_turns: number;
  stateless_turns: number;
}

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(iso: string): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

type UsagePeriod = 'this_week' | 'last_week';

// Claude Max resets weekly on Thursday 00:00 UTC
const RESET_DAY = 4; // Thursday (0=Sun, 4=Thu)
function getWeekBoundaries(period: UsagePeriod): { since: string; until?: string } {
  const now = new Date();
  // Find the most recent Thursday 00:00 UTC
  const daysSinceReset = (now.getUTCDay() - RESET_DAY + 7) % 7;
  const thisWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceReset));
  if (period === 'this_week') {
    return { since: thisWeekStart.toISOString() };
  }
  // Last week: previous Thursday to this Thursday
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);
  return { since: lastWeekStart.toISOString(), until: thisWeekStart.toISOString() };
}

interface AgentAlert {
  id: number;
  group_folder: string;
  group_name: string;
  type: string;
  message: string;
  duration_ms: number | null;
  num_turns: number | null;
  cost_usd: number | null;
  context_percent: number | null;
  created_at: string;
  dismissed: boolean;
}

interface ClaudeUsage {
  session: { percent: number; resetIn: string | null } | null;
  weeklyAll: { percent: number; resets: string | null } | null;
  weeklySonnet: { percent: number; resets: string | null } | null;
  scrapedAt: string;
}

export function OverviewView({ groups, status, processingFolders, onSelectGroup, onRefresh }: Props) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage[]>([]);
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>('this_week');
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsage | null>(null);
  const [alerts, setAlerts] = useState<AgentAlert[]>([]);

  useEffect(() => {
    api.getAnalytics().then(r => { if (r.ok) setAnalytics(r.data); }).catch(() => {});
    api.getClaudeUsage().then(r => { if (r.ok && r.data) setClaudeUsage(r.data); }).catch(() => {});
    api.getAlerts().then(r => { if (r.ok) setAlerts(r.data.filter(a => !a.dismissed)); }).catch(() => {});
  }, []);

  useEffect(() => {
    const { since, until } = getWeekBoundaries(usagePeriod);
    api.getTokenUsage({ since, until }).then(r => { if (r.ok) setTokenUsage(r.data); }).catch(() => {});
  }, [usagePeriod]);

  const totalTokensAllGroups = tokenUsage.reduce((s, u) => s + u.total_tokens, 0);
  const totalTurns = tokenUsage.reduce((s, u) => s + u.turn_count, 0);
  const totalStatefulTokens = tokenUsage.reduce((s, u) => s + (u.stateful_tokens || 0), 0);
  const totalStatelessTokens = tokenUsage.reduce((s, u) => s + (u.stateless_tokens || 0), 0);

  // Map folder to group name
  const folderToName: Record<string, string> = {};
  if (analytics) {
    for (const g of analytics.groups) folderToName[g.folder] = g.name;
  }
  for (const g of groups) folderToName[g.folder] = g.name;

  return (
    <div className="overview-view">
      {/* Stats cards */}
      <div className="overview-stats">
        <div className="card stat-card">
          <span className="mi" style={{ fontSize: 24, color: 'var(--purple)' }}>groups</span>
          <div className="value">{status?.groupCount ?? '—'}</div>
          <div className="label">Groups</div>
        </div>
        <div className="card stat-card">
          <span className="mi" style={{ fontSize: 24, color: 'var(--purple)' }}>schedule</span>
          <div className="value">{analytics?.activeTasks ?? status?.activeTasks ?? '—'}</div>
          <div className="label">Active Tasks</div>
        </div>
        <div className="card stat-card">
          <span className="mi" style={{ fontSize: 24, color: 'var(--purple)' }}>terminal</span>
          <div className="value">{status?.sessionCount ?? '—'}</div>
          <div className="label">Sessions</div>
        </div>
        <div className="card stat-card">
          <span className="mi" style={{ fontSize: 24, color: 'var(--purple)' }}>timer</span>
          <div className="value">{status ? fmtUptime(status.uptime) : '—'}</div>
          <div className="label">Uptime</div>
        </div>
      </div>

      {/* Agent Alerts */}
      {alerts.length > 0 && (
        <div className="overview-section">
          <div className="overview-section-header">
            <h3>Alerts</h3>
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>{alerts.length} active</span>
          </div>
          <div className="alert-list">
            {alerts.map(a => (
              <div key={a.id} className="alert-row">
                <span className="mi" style={{ fontSize: 18, color: a.type === 'high_cost' || a.type === 'slow_response' ? 'var(--error)' : 'var(--orange)', flexShrink: 0 }}>
                  {a.type === 'slow_response' ? 'speed' : a.type === 'high_turns' ? 'repeat' : a.type === 'high_cost' ? 'paid' : 'memory'}
                </span>
                <div className="alert-content">
                  <div className="alert-message">{a.message}</div>
                  <div className="alert-meta">{timeAgo(a.created_at)}</div>
                </div>
                <button className="alert-dismiss" onClick={async () => {
                  await api.dismissAlert(a.id);
                  setAlerts(prev => prev.filter(x => x.id !== a.id));
                }}>
                  <span className="mi" style={{ fontSize: 16 }}>close</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Claude Plan Usage */}
      {claudeUsage && (
        <div className="overview-section">
          <div className="overview-section-header">
            <h3>Claude Plan Usage</h3>
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>
              {claudeUsage.scrapedAt ? `Last updated ${timeAgo(claudeUsage.scrapedAt)}` : ''}
            </span>
          </div>
          <div className="claude-usage-bars">
            {claudeUsage.session && (
              <div className="claude-usage-row">
                <div className="claude-usage-label">
                  <span>Session</span>
                  <span style={{ color: 'var(--text2)', fontSize: 11 }}>{claudeUsage.session.resetIn ? `resets in ${claudeUsage.session.resetIn}` : ''}</span>
                </div>
                <div className="usage-bar-track">
                  <div className="usage-bar-fill" style={{
                    width: `${Math.max(claudeUsage.session.percent, 2)}%`,
                    backgroundColor: claudeUsage.session.percent > 80 ? 'var(--error)' : claudeUsage.session.percent > 50 ? 'var(--orange)' : undefined,
                  }} />
                </div>
                <div className="usage-bar-value">{claudeUsage.session.percent}%</div>
              </div>
            )}
            {claudeUsage.weeklyAll && (
              <div className="claude-usage-row">
                <div className="claude-usage-label">
                  <span>Weekly — All</span>
                  <span style={{ color: 'var(--text2)', fontSize: 11 }}>{claudeUsage.weeklyAll.resets ? `resets ${claudeUsage.weeklyAll.resets}` : ''}</span>
                </div>
                <div className="usage-bar-track">
                  <div className="usage-bar-fill" style={{
                    width: `${Math.max(claudeUsage.weeklyAll.percent, 2)}%`,
                    backgroundColor: claudeUsage.weeklyAll.percent > 80 ? 'var(--error)' : claudeUsage.weeklyAll.percent > 50 ? 'var(--orange)' : undefined,
                  }} />
                </div>
                <div className="usage-bar-value">{claudeUsage.weeklyAll.percent}%</div>
              </div>
            )}
            {claudeUsage.weeklySonnet && (
              <div className="claude-usage-row">
                <div className="claude-usage-label">
                  <span>Weekly — Sonnet</span>
                  <span style={{ color: 'var(--text2)', fontSize: 11 }}>{claudeUsage.weeklySonnet.resets ? `resets ${claudeUsage.weeklySonnet.resets}` : ''}</span>
                </div>
                <div className="usage-bar-track">
                  <div className="usage-bar-fill" style={{
                    width: `${Math.max(claudeUsage.weeklySonnet.percent, 2)}%`,
                    backgroundColor: claudeUsage.weeklySonnet.percent > 80 ? 'var(--error)' : claudeUsage.weeklySonnet.percent > 50 ? 'var(--orange)' : undefined,
                  }} />
                </div>
                <div className="usage-bar-value">{claudeUsage.weeklySonnet.percent}%</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Token Usage */}
      <div className="overview-section">
        <div className="overview-section-header">
          <h3>Token Usage</h3>
          <div className="usage-period-pills">
            {([['this_week', 'This Week'], ['last_week', 'Last Week']] as [UsagePeriod, string][]).map(([p, label]) => (
              <button
                key={p}
                className={`period-pill${usagePeriod === p ? ' active' : ''}`}
                onClick={() => setUsagePeriod(p)}
              >{label}</button>
            ))}
          </div>
        </div>
        <div className="usage-summary">
          <span className="usage-total">{fmtTokens(totalTokensAllGroups)} tokens</span>
          <span className="usage-turns">{totalTurns} turns</span>
        </div>
        {totalStatelessTokens > 0 && (
          <div className="usage-mode-split">
            <span className="mode-pill stateful">Stateful {fmtTokens(totalStatefulTokens)}</span>
            <span className="mode-pill stateless">Stateless {fmtTokens(totalStatelessTokens)}</span>
          </div>
        )}
        {tokenUsage.length > 0 ? (
          <div className="usage-bars">
            {tokenUsage.map(u => {
              const statefulPct = totalTokensAllGroups > 0 ? ((u.stateful_tokens || 0) / totalTokensAllGroups) * 100 : 0;
              const statelessPct = totalTokensAllGroups > 0 ? ((u.stateless_tokens || 0) / totalTokensAllGroups) * 100 : 0;
              const hasStateless = (u.stateless_tokens || 0) > 0;
              return (
                <div key={u.group_folder} className="usage-bar-row">
                  <div className="usage-bar-label">{folderToName[u.group_folder] || u.group_folder}</div>
                  <div className="usage-bar-track">
                    <div className="usage-bar-fill stateful" style={{ width: `${Math.max(statefulPct, hasStateless ? 0 : 2)}%` }} />
                    {hasStateless && (
                      <div className="usage-bar-fill stateless" style={{ width: `${Math.max(statelessPct, 1)}%` }} />
                    )}
                  </div>
                  <div className="usage-bar-value">
                    {fmtTokens(u.total_tokens)}
                    {hasStateless && <span className="usage-bar-stateless-tag">{fmtTokens(u.stateless_tokens)} SL</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="usage-empty">No usage data yet</div>
        )}
      </div>

      {/* Agent list */}
      <div className="overview-section">
        <div className="overview-section-header">
          <h3>Agents</h3>
          <button className="overview-refresh" onClick={onRefresh}>
            <span className="mi" style={{ fontSize: 18 }}>refresh</span>
          </button>
        </div>
        <div className="overview-agents">
          {(analytics?.groups || groups.map(g => ({
            jid: g.jid,
            name: g.name,
            folder: g.folder,
            channel: g.channel,
            totalMessages: 0,
            userMessages: 0,
            botMessages: 0,
            hasSession: g.hasSession,
            lastActivity: g.lastActivity,
            transcriptSize: 0,
            currentTranscriptSize: 0,
            contextPercent: 0,
            attachmentSize: 0,
          }))).map(g => (
            <div key={g.jid} className="overview-agent-row" onClick={() => onSelectGroup(g.jid)}>
              <div className="overview-agent-avatar">
                <span className="mi mi-fill" style={{ fontSize: 20 }}>smart_toy</span>
                {(g.hasSession || processingFolders.has(g.folder)) && <div className="overview-agent-dot" />}
              </div>
              <div className="overview-agent-info">
                <div className="overview-agent-name">{g.name}</div>
                <div className="overview-agent-meta">
                  {g.channel} &middot; {timeAgo(g.lastActivity)}
                  {g.totalMessages > 0 && <> &middot; {g.totalMessages} msgs</>}
                </div>
                {(g.hasSession || g.contextPercent > 0 || g.currentTranscriptSize > 0 || g.transcriptSize > 0) && (
                  <div className="overview-agent-meta">
                    {g.contextPercent > 0 && <span style={{
                      color: g.contextPercent > 80 ? 'var(--error)' : g.contextPercent > 50 ? 'var(--orange)' : undefined,
                    }}>ctx {g.contextPercent}%</span>}
                    {g.currentTranscriptSize > 0 && <>{g.contextPercent > 0 && ' · '}{fmtBytes(g.currentTranscriptSize)} session</>}
                    {g.transcriptSize > 0 && <> · {fmtBytes(g.transcriptSize)} total</>}
                  </div>
                )}
                {g.attachmentSize > 0 && (
                  <div className="overview-agent-meta">
                    <span className="mi" style={{ fontSize: 12, verticalAlign: -2, marginRight: 2 }}>folder</span>
                    {fmtBytes(g.attachmentSize)} attachments
                  </div>
                )}
              </div>
              {processingFolders.has(g.folder) && (
                <span className="processing-badge" style={{ fontSize: 11 }}>Processing</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
