import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getSocket } from './socket';
import { ChatView } from './components/ChatView';
import { OverviewView } from './components/OverviewView';
import { TasksView } from './components/TasksView';
import { SettingsView } from './components/SettingsView';
import { TodosView } from './components/TodosView';
import './styles.css';
import { useNotifications } from './hooks/useNotifications';

export type View = 'chat' | 'overview' | 'tasks' | 'todos' | 'settings';

export interface Group {
  jid: string;
  name: string;
  folder: string;
  channel: string;
  lastActivity: string;
  isMain: boolean;
  isTransient: boolean;
  requiresTrigger: boolean;
  hasSession: boolean;
  showInSidebar: boolean;
  model: string;
}

export interface Status {
  uptime: number;
  assistantName: string;
  groupCount: number;
  taskCount: number;
  activeTasks: number;
  sessionCount: number;
}

const TABS: { view: View; icon: string; label: string }[] = [
  { view: 'chat', icon: 'chat', label: 'Chat' },
  { view: 'overview', icon: 'dashboard', label: 'Overview' },
  { view: 'tasks', icon: 'schedule', label: 'Tasks' },
  { view: 'todos', icon: 'checklist', label: 'Todos' },
  { view: 'settings', icon: 'settings', label: 'Settings' },
];

export function App() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedJid, _setSelectedJid] = useState<string | null>(() => localStorage.getItem('selectedJid'));
  const setSelectedJid = (jidOrFn: string | null | ((prev: string | null) => string | null)) => {
    _setSelectedJid(prev => {
      const next = typeof jidOrFn === 'function' ? jidOrFn(prev) : jidOrFn;
      if (next) localStorage.setItem('selectedJid', next);
      else localStorage.removeItem('selectedJid');
      return next;
    });
  };
  const [view, setView] = useState<View>('chat');
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState(false);
  const [processingFolders, setProcessingFolders] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [contextPercent, setContextPercent] = useState<Record<string, number>>({});
  const [reconnectKey, setReconnectKey] = useState(0);
  const [messageCache, setMessageCache] = useState<Record<string, any[]>>({});
  const swipeRef = useRef<{ startX: number; startY: number } | null>(null);
  const { permission, subscribed, subscribe, loading, supported } = useNotifications();

  // Deep link: intercept clicks on #tasks, #todos, etc. to switch tabs
  useEffect(() => {
    const VALID_VIEWS = ['chat', 'overview', 'tasks', 'todos', 'settings'];
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('#') && VALID_VIEWS.includes(href.slice(1))) {
        e.preventDefault();
        setView(href.slice(1) as View);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Swipe from left edge to open drawer
  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch.clientX < 25) {
        swipeRef.current = { startX: touch.clientX, startY: touch.clientY };
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!swipeRef.current) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - swipeRef.current.startX;
      const dy = Math.abs(touch.clientY - swipeRef.current.startY);
      swipeRef.current = null;
      if (dx > 60 && dy < 100) setDrawerOpen(true);
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  // Fix mobile keyboard — resize app to match visible viewport
  const appRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const el = appRef.current;
      if (!el) return;
      // Set exact height to visible viewport (excludes keyboard)
      el.style.height = `${vv.height}px`;
      // Counteract any scroll offset iOS adds when focusing input
      el.style.transform = `translateY(${vv.offsetTop}px)`;
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    // Also run on initial mount
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  const loadData = () => {
    api.getStatus().then(r => r.ok && setStatus(r.data)).catch(() => {});
    api.getMe().then(r => { if (r.ok) setIsOwner(r.data.isOwner); }).catch(() => {});
    api.getGroups().then(r => {
      if (r.ok) {
        setGroups(r.data);
        // Auto-select main group only on very first load
        setSelectedJid(prev => {
          if (prev) return prev; // Already selected, don't override
          const main = r.data.find((g: Group) => g.isMain);
          return main ? main.jid : r.data.length > 0 ? r.data[0].jid : prev;
        });
      }
    }).catch(() => {});
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    const socket = getSocket();
    socket.on('connect', () => {
      setConnected(true);
      setReconnectKey(k => k + 1);
      // On reconnect, fetch current processing state from server as fallback
      // (server also re-emits agent:spawn on socket connect, but this handles any race)
      api.getProcessing().then(r => {
        if (r.ok) {
          setProcessingFolders(new Set(r.data.activeGroupFolders));
        } else {
          setProcessingFolders(new Set());
        }
      }).catch(() => setProcessingFolders(new Set()));
    });
    socket.on('disconnect', () => setConnected(false));
    const processingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    socket.on('agent:spawn', (d: { groupFolder: string }) => {
      setProcessingFolders(prev => new Set(prev).add(d.groupFolder));
      // Safety timeout: clear "thinking" after 5 minutes (agent likely done or stuck)
      if (processingTimers.has(d.groupFolder)) clearTimeout(processingTimers.get(d.groupFolder)!);
      processingTimers.set(d.groupFolder, setTimeout(() => {
        setProcessingFolders(prev => { const n = new Set(prev); n.delete(d.groupFolder); return n; });
        processingTimers.delete(d.groupFolder);
      }, 300000));
    });
    const clearProcessing = (d: { groupFolder: string }) => {
      setProcessingFolders(prev => { const n = new Set(prev); n.delete(d.groupFolder); return n; });
      if (processingTimers.has(d.groupFolder)) {
        clearTimeout(processingTimers.get(d.groupFolder)!);
        processingTimers.delete(d.groupFolder);
      }
    };
    socket.on('agent:idle', clearProcessing);
    socket.on('agent:exit', clearProcessing);
    socket.on('context:update', (d: { groupFolder: string; percent: number }) => {
      setContextPercent(prev => ({ ...prev, [d.groupFolder]: d.percent }));
    });
    return () => {
      clearInterval(interval);
      socket.off('connect'); socket.off('disconnect');
      socket.off('agent:spawn'); socket.off('agent:idle', clearProcessing); socket.off('agent:exit', clearProcessing); socket.off('context:update');
    };
  }, []);

  // Load context % for all groups when groups list loads
  useEffect(() => {
    groups.forEach(g => {
      api.getContextUsage(g.jid).then(r => {
        if (r.ok) {
          setContextPercent(prev => ({ ...prev, [g.folder]: r.data.percent }));
        }
      }).catch(() => {});
    });
  }, [groups]);

  const handleSelectGroup = (jid: string) => {
    setSelectedJid(jid);
    setView('chat');
    setDrawerOpen(false);
  };

  const selectedGroup = groups.find(g => g.jid === selectedJid);

  return (
    <div className="app" ref={appRef}>
      {/* Top app bar */}
      <div className="top-bar">
        <button className="top-bar-menu" onClick={() => setDrawerOpen(!drawerOpen)}>
          <span className="mi">menu</span>
        </button>
        <span className="top-bar-title">
          {selectedGroup?.name || status?.assistantName || 'NanoPo'}
          {selectedGroup && processingFolders.has(selectedGroup.folder) && (
            <span className="typing-dots" style={{ marginLeft: 6, fontSize: 14 }}><span>.</span><span>.</span><span>.</span></span>
          )}
        </span>
        <span className={`top-bar-badge ${connected ? 'live' : 'offline'}`}>
          {connected ? (selectedGroup && processingFolders.has(selectedGroup.folder) ? 'Thinking' : 'Active') : 'Offline'}
        </span>
        {selectedGroup && (
          <span className="top-bar-context" style={{
            color: contextPercent[selectedGroup.folder] > 80 ? 'var(--error)' : contextPercent[selectedGroup.folder] > 50 ? 'var(--orange)' : 'var(--text2)',
          }}>
            {selectedGroup.model === 'sonnet' ? 'S' : 'O'}
            {contextPercent[selectedGroup.folder] != null ? ` ${contextPercent[selectedGroup.folder]}%` : ''}
          </span>
        )}
        <div className="top-bar-spacer" />
        {supported && !subscribed && permission !== 'denied' && (
          <button
            className="top-bar-refresh"
            onClick={subscribe}
            disabled={loading}
            title="Enable notifications"
            style={{ color: permission === 'default' ? 'var(--primary)' : undefined }}
          >
            <span className="mi">notifications</span>
          </button>
        )}
        {supported && subscribed && (
          <button className="top-bar-refresh" title="Notifications on" style={{ color: 'var(--primary)' }} disabled>
            <span className="mi mi-fill">notifications_active</span>
          </button>
        )}
        <button className="top-bar-refresh" onClick={async () => {
          // Force-clear SW caches and reload to pick up new builds on iOS PWA
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.update()));
          }
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
          }
          window.location.reload();
        }}>
          <span className="mi">refresh</span>
        </button>
      </div>

      {/* Swipe edge zone + Drawer overlay */}
      {!drawerOpen && <div className="swipe-edge" />}
      <div className={`drawer-overlay ${drawerOpen ? 'visible' : ''}`} onClick={() => setDrawerOpen(false)} />

      {/* Agent drawer */}
      <div className={`drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="drawer-header">
          <span className="drawer-title">Agents</span>
          <button className="drawer-close" onClick={() => setDrawerOpen(false)}>
            <span className="mi">close</span>
          </button>
        </div>
        {groups.filter(g => isOwner ? g.showInSidebar !== false : true).map(g => (
          <div
            key={g.jid}
            className={`agent-card ${selectedJid === g.jid ? 'active' : ''}`}
            onClick={() => handleSelectGroup(g.jid)}
          >
            <div className="agent-avatar">
              <span className="mi mi-fill" style={{ fontSize: 22 }}>smart_toy</span>
            </div>
            <div className="agent-info">
              <div className="agent-name">{g.name}</div>
              <div className="agent-status">
                {processingFolders.has(g.folder) ? 'Processing...' : g.hasSession ? 'Active Now' : `${g.channel} · idle`}
                <span style={{
                  marginLeft: 6,
                  color: contextPercent[g.folder] > 80 ? 'var(--error)' : contextPercent[g.folder] > 50 ? 'var(--orange)' : 'inherit',
                }}>· {g.model === 'sonnet' ? 'S' : 'O'}{contextPercent[g.folder] != null ? ` ${contextPercent[g.folder]}%` : ''}</span>
              </div>
            </div>
            {(g.hasSession || processingFolders.has(g.folder)) && <div className="agent-dot" />}
          </div>
        ))}
      </div>

      {/* Main content */}
      <main className="main-content">
        {view === 'chat' && (
          <ChatView
            groups={groups}
            selectedJid={selectedJid}
            selectedGroup={selectedGroup}
            processingFolders={processingFolders}
            onSelectGroup={setSelectedJid}
            connected={connected}
            drawerOpen={drawerOpen}
            onToggleDrawer={() => setDrawerOpen(!drawerOpen)}
            messageCache={messageCache}
            setMessageCache={setMessageCache}
            reconnectKey={reconnectKey}
          />
        )}
        {view === 'overview' && (
          <OverviewView groups={groups} status={status} processingFolders={processingFolders} onSelectGroup={handleSelectGroup} onRefresh={loadData} />
        )}
        {view === 'tasks' && <TasksView />}
        {view === 'todos' && <TodosView />}
        {view === 'settings' && <SettingsView groups={groups} />}
      </main>

      {/* Bottom nav — always visible */}
      <div className="tab-bar">
        {TABS.map(tab => (
          <button
            key={tab.view}
            className={`tab-item ${view === tab.view ? 'active' : ''}`}
            onClick={() => setView(tab.view)}
          >
            <span className="tab-icon-wrap">
              <span className={`mi ${view === tab.view ? 'mi-fill' : ''}`}>{tab.icon}</span>
            </span>
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
