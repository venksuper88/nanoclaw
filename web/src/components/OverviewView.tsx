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
  }>;
  totalGroups: number;
  totalTasks: number;
  activeTasks: number;
  totalSessions: number;
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

export function OverviewView({ groups, status, processingFolders, onSelectGroup, onRefresh }: Props) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  useEffect(() => {
    api.getAnalytics().then(r => { if (r.ok) setAnalytics(r.data); }).catch(() => {});
  }, []);

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
