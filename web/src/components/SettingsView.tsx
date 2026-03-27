import { useEffect, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';
import type { Group } from '../App';

interface LogEntry { name: string; content: string; }
interface LiveEvent { type: string; group: string; time: string; }
interface Mem0Stats {
  totalRecords: number;
  dbSize: string;
  actions: Record<string, number>;
  recent?: Array<{ id: string; value: string; action: string; createdAt: string }>;
}
interface MemoryEntry {
  id: string;
  memory: string;
  metadata?: { scope?: string | string[]; groupFolder?: string; _userId?: string };
}
interface TokenInfo {
  token: string;
  tokenFull: string;
  name: string;
  role: string;
  allowedGroups: string[];
  canSend: boolean;
  isOwner: boolean;
  createdAt: string;
  reminderGroupJid: string | null;
}
interface ScopeDef {
  name: string;
  description: string;
  created_at: string;
}

export function SettingsView({ groups }: { groups: Group[] }) {
  const [section, setSection] = useState<'groups' | 'tokens' | 'mem0' | 'logs'>('groups');
  const [folder, setFolder] = useState(() => (groups.find(g => g.isMain) || groups[0])?.folder || '');

  // When groups load async, set default folder to main group if not yet set
  useEffect(() => {
    if (!folder && groups.length > 0) {
      setFolder((groups.find(g => g.isMain) || groups[0]).folder);
    }
  }, [groups, folder]);

  const [containerLogs, setContainerLogs] = useState<Record<string, Array<{ line: string; stream: 'stdout' | 'stderr'; ts: string }>>>({});
  const [mem0, setMem0] = useState<Mem0Stats | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newGroups, setNewGroups] = useState<string[]>([]);
  const [newCanSend, setNewCanSend] = useState(true);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [editingMemory, setEditingMemory] = useState<string | null>(null);
  const [memoryFilter, setMemoryFilter] = useState<'all' | 'private' | 'shared'>('all');
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [groupSettings, setGroupSettings] = useState<Record<string, { memoryMode: string; memoryScopes: string[]; memoryUserId: string; isTransient: boolean; showInSidebar: boolean; idleTimeoutMinutes: number | null; allowedSkills: string[]; tokens: Array<{ name: string; role: string; isOwner: boolean }> }>>({});
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);

  // Scope definitions
  const [scopes, setScopes] = useState<ScopeDef[]>([]);
  const [showScopeCreate, setShowScopeCreate] = useState(false);
  const [newScopeName, setNewScopeName] = useState('');
  const [newScopeDesc, setNewScopeDesc] = useState('');

  // Move-to-shared state
  const [movingMemory, setMovingMemory] = useState<string | null>(null);
  const [suggestedScope, setSuggestedScope] = useState<string | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);

  // Check if owner + load available skills
  useEffect(() => {
    api.getMe().then(r => {
      if (r.ok) setIsOwner(r.data.isOwner);
    }).catch(() => {});
    api.getSkills().then(r => {
      if (r.ok) {
        // Only container skills (folder starts with container/skills/)
        const containerSkills = r.data
          .filter((s: { folder: string }) => s.folder.startsWith('container/skills/'))
          .map((s: { folder: string }) => s.folder.replace('container/skills/', ''));
        setAvailableSkills(containerSkills);
      }
    }).catch(() => {});
  }, []);

  // Load tokens
  useEffect(() => {
    if (section !== 'tokens' || !isOwner) return;
    api.getTokens().then(r => { if (r.ok) setTokens(r.data); }).catch(() => {});
  }, [section, isOwner]);

  // Load mem0 stats + memories + scopes
  useEffect(() => {
    if (section !== 'mem0') return;
    api.getMem0Stats().then(r => { if (r.ok) setMem0(r.data); }).catch(() => {});
    if (isOwner) {
      api.getMemories().then(r => { if (r.ok) setMemories(r.data); }).catch(() => {});
      api.getScopes().then(r => { if (r.ok) setScopes(r.data); }).catch(() => {});
    }
  }, [section, isOwner]);

  // Live container logs
  useEffect(() => {
    const socket = getSocket();
    socket.on('container:log', (d: { groupFolder: string; line: string; stream: 'stdout' | 'stderr' }) => {
      setContainerLogs(prev => {
        const existing = prev[d.groupFolder] || [];
        const entry = { line: d.line, stream: d.stream, ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
        return { ...prev, [d.groupFolder]: [...existing, entry].slice(-10) };
      });
    });
    return () => { socket.off('container:log'); };
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const r = await api.createToken(newName.trim(), newRole.trim(), newGroups, newCanSend);
      if (r.ok) {
        setCreatedToken(r.data.token);
        setNewName('');
        setNewRole('');
        setNewGroups([]);
        setNewCanSend(true);
        setShowCreate(false);
        api.getTokens().then(r2 => { if (r2.ok) setTokens(r2.data); }).catch(() => {});
      }
    } catch {}
  };

  const handleDelete = async (token: string, name: string) => {
    if (!confirm(`Revoke access for ${name}?`)) return;
    await api.deleteToken(token);
    api.getTokens().then(r => { if (r.ok) setTokens(r.data); }).catch(() => {});
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token).then(() => {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    }).catch(() => {});
  };

  const toggleGroup = (jid: string) => {
    setNewGroups(prev =>
      prev.includes(jid) ? prev.filter(g => g !== jid) : [...prev, jid]
    );
  };

  const handleCreateScope = async () => {
    if (!newScopeName.trim() || !newScopeDesc.trim()) return;
    await api.createScope(newScopeName.trim().toLowerCase().replace(/\s+/g, '-'), newScopeDesc.trim());
    setNewScopeName('');
    setNewScopeDesc('');
    setShowScopeCreate(false);
    api.getScopes().then(r => { if (r.ok) setScopes(r.data); }).catch(() => {});
  };

  const handleDeleteScope = async (name: string) => {
    if (!confirm(`Delete scope "${name}"? Memories under it become unscoped.`)) return;
    await api.deleteScope(name);
    api.getScopes().then(r => { if (r.ok) setScopes(r.data); }).catch(() => {});
  };

  const handleMoveToShared = async (m: MemoryEntry) => {
    setMovingMemory(m.id);
    setMoveLoading(true);
    setSuggestedScope(null);
    try {
      const r = await api.suggestScope(m.memory);
      if (r.ok && r.data.scope) {
        setSuggestedScope(r.data.scope);
      }
    } catch {}
    setMoveLoading(false);
  };

  const confirmMoveToShared = async (memoryId: string, scope: string) => {
    const m = memories.find(x => x.id === memoryId);
    const sourceUserId = m?.metadata?._userId || 'venky';
    await api.moveToShared(memoryId, scope, sourceUserId);
    setMovingMemory(null);
    setSuggestedScope(null);
    api.getMemories().then(r => { if (r.ok) setMemories(r.data); }).catch(() => {});
  };

  const privateMemories = memories.filter(m => m.metadata?._userId !== 'shared');
  const sharedMemories = memories.filter(m => m.metadata?._userId === 'shared');
  const filteredMemories = memoryFilter === 'all' ? memories :
    memoryFilter === 'private' ? privateMemories : sharedMemories;

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1>Settings</h1>
        <div className="segmented">
          {isOwner && <button className={`seg-btn ${section === 'groups' ? 'active' : ''}`} onClick={() => setSection('groups')}>Groups</button>}
          {isOwner && <button className={`seg-btn ${section === 'tokens' ? 'active' : ''}`} onClick={() => setSection('tokens')}>Access</button>}
          <button className={`seg-btn ${section === 'mem0' ? 'active' : ''}`} onClick={() => setSection('mem0')}>Memory</button>
          <button className={`seg-btn ${section === 'logs' ? 'active' : ''}`} onClick={() => setSection('logs')}>Logs</button>
        </div>
      </div>

      {/* ── Groups ── */}
      {section === 'groups' && isOwner && (
        <>
          <div className="section-label">Agent Groups</div>
          <div className="list-group">
            {groups.map(g => {
              const isExpanded = expandedGroup === g.jid;
              const gs = groupSettings[g.jid];

              const loadSettings = () => {
                api.getGroupSettings(g.jid).then(r => {
                  if (r.ok) setGroupSettings(prev => ({ ...prev, [g.jid]: r.data }));
                }).catch(() => {});
              };

              const toggleExpand = () => {
                if (isExpanded) { setExpandedGroup(null); return; }
                setExpandedGroup(g.jid);
                if (!gs) loadSettings();
              };

              const updateSetting = async (update: { memoryMode?: string; memoryScopes?: string[]; memoryUserId?: string; isTransient?: boolean; showInSidebar?: boolean; idleTimeoutMinutes?: number | null; allowedSkills?: string[] }) => {
                await api.updateGroupSettings(g.jid, update);
                loadSettings();
              };

              return (
                <div key={g.jid} className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 0, cursor: 'pointer' }} onClick={toggleExpand}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 12, background: g.isMain ? 'var(--purple)' : 'var(--text3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <span className="mi mi-fill" style={{ fontSize: 18, color: 'white' }}>smart_toy</span>
                    </div>
                    <div className="list-content">
                      <div className="list-title">{g.name}</div>
                      <div className="list-subtitle">
                        {g.channel} &middot; {g.isMain ? 'main' : g.isTransient ? 'transient' : 'permanent'}
                        {gs?.memoryUserId && gs.memoryUserId !== 'venky' ? ` \u00B7 user: ${gs.memoryUserId}` : ''}
                      </div>
                    </div>
                    <span className={`badge ${(gs?.memoryMode || 'full') === 'full' ? 'badge-green' : (gs?.memoryMode || 'full') === 'local' ? 'badge-blue' : 'badge-orange'}`}>
                      {gs?.memoryMode || 'full'}
                    </span>
                    <span className="mi" style={{ fontSize: 18, color: 'var(--text3)' }}>
                      {isExpanded ? 'expand_less' : 'expand_more'}
                    </span>
                  </div>

                  {isExpanded && gs && (
                    <div onClick={e => e.stopPropagation()} style={{ padding: '12px 0 4px' }}>
                      {/* Memory Mode */}
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Memory Mode</div>
                        <div className="segmented">
                          <button className={`seg-btn ${gs.memoryMode === 'full' ? 'active' : ''}`} onClick={() => updateSetting({ memoryMode: 'full' })}>Full</button>
                          <button className={`seg-btn ${gs.memoryMode === 'local' ? 'active' : ''}`} onClick={() => updateSetting({ memoryMode: 'local' })}>Local</button>
                          <button className={`seg-btn ${gs.memoryMode === 'none' ? 'active' : ''}`} onClick={() => updateSetting({ memoryMode: 'none' })}>None</button>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                          {gs.memoryMode === 'full' ? 'mem0 dual search (private + shared scopes)' : gs.memoryMode === 'local' ? 'Agent uses only its CLAUDE.md — no injected memories' : 'No memory at all (read or write)'}
                        </div>
                      </div>

                      {/* Memory User ID */}
                      {gs.memoryMode === 'full' && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Memory User ID</div>
                          <input
                            value={gs.memoryUserId || 'venky'}
                            onChange={e => {
                              setGroupSettings(prev => ({ ...prev, [g.jid]: { ...gs, memoryUserId: e.target.value } }));
                            }}
                            onBlur={e => {
                              const val = e.target.value.trim().toLowerCase();
                              if (val && val !== (gs.memoryUserId || 'venky')) {
                                updateSetting({ memoryUserId: val });
                              }
                            }}
                            placeholder="venky"
                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }}
                          />
                          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                            Private memory pool for this group. Different users get isolated memories.
                          </div>
                        </div>
                      )}

                      {/* Shared Memory Scopes (only when full) */}
                      {gs.memoryMode === 'full' && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Shared Scopes</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {scopes.map(scope => (
                              <button
                                key={scope.name}
                                className={`btn btn-sm ${gs.memoryScopes.includes(scope.name) ? 'btn-blue' : 'btn-outline'}`}
                                title={scope.description}
                                onClick={() => {
                                  const next = gs.memoryScopes.includes(scope.name)
                                    ? gs.memoryScopes.filter((s: string) => s !== scope.name)
                                    : [...gs.memoryScopes, scope.name];
                                  updateSetting({ memoryScopes: next });
                                }}
                              >
                                {scope.name}
                              </button>
                            ))}
                            {scopes.length === 0 && (
                              <span style={{ fontSize: 12, color: 'var(--text2)' }}>No scopes defined — create them in Memory tab</span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                            {gs.memoryScopes.length === 0
                              ? 'No shared access — sees only private memories'
                              : `Shared access: ${gs.memoryScopes.join(', ')}`}
                          </div>
                        </div>
                      )}

                      {/* User Access */}
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>User Access</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {gs.tokens.map(t => (
                            <span key={t.name} className={`badge ${t.isOwner ? 'badge-green' : 'badge-blue'}`}>
                              {t.name} {t.role ? `(${t.role})` : ''}
                            </span>
                          ))}
                          {gs.tokens.length === 0 && <span style={{ fontSize: 12, color: 'var(--text2)' }}>No users assigned</span>}
                        </div>
                      </div>

                      {/* Container Lifecycle */}
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Container Lifecycle</div>
                        <div className="segmented">
                          <button className={`seg-btn ${gs.idleTimeoutMinutes === 0 ? 'active' : ''}`}
                            onClick={() => updateSetting({ idleTimeoutMinutes: 0, isTransient: false })}
                          >Always On</button>
                          <button className={`seg-btn ${gs.idleTimeoutMinutes !== 0 && !gs.isTransient ? 'active' : ''}`}
                            onClick={() => updateSetting({ idleTimeoutMinutes: null, isTransient: false })}
                          >Cooldown</button>
                          <button className={`seg-btn ${gs.isTransient ? 'active' : ''}`}
                            onClick={() => updateSetting({ isTransient: true, idleTimeoutMinutes: null })}
                            disabled={g.isMain}
                          >Transient</button>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                          {gs.idleTimeoutMinutes === 0 ? 'Container never auto-closes' :
                           gs.isTransient ? 'Container closes after each response' :
                           `Container closes after ${gs.idleTimeoutMinutes || 30} min idle`}
                        </div>
                        {gs.idleTimeoutMinutes !== 0 && !gs.isTransient && (
                          <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Timeout:</span>
                            {[5, 15, 30, 60].map(m => (
                              <button key={m}
                                className={`btn btn-sm ${(gs.idleTimeoutMinutes || 30) === m ? 'btn-blue' : 'btn-outline'}`}
                                onClick={() => updateSetting({ idleTimeoutMinutes: m })}
                              >{m}m</button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Skills */}
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Skills</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {availableSkills.map(skill => {
                            const isAllowed = gs.allowedSkills.length === 0 || gs.allowedSkills.includes(skill);
                            const isAllMode = gs.allowedSkills.length === 0;
                            return (
                              <button key={skill}
                                className={`btn btn-sm ${isAllowed ? 'btn-blue' : 'btn-outline'}`}
                                onClick={() => {
                                  if (isAllMode) {
                                    // Switch from "all" to "all except this one"
                                    updateSetting({ allowedSkills: availableSkills.filter(s => s !== skill) });
                                  } else if (isAllowed) {
                                    const next = gs.allowedSkills.filter(s => s !== skill);
                                    updateSetting({ allowedSkills: next.length === 0 ? ['__none__'] : next });
                                  } else {
                                    const next = [...gs.allowedSkills.filter(s => s !== '__none__'), skill];
                                    updateSetting({ allowedSkills: next.length >= availableSkills.length ? [] : next });
                                  }
                                }}
                              >{skill}</button>
                            );
                          })}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                          {gs.allowedSkills.length === 0 ? 'All skills enabled' :
                           gs.allowedSkills[0] === '__none__' ? 'No skills' :
                           `${gs.allowedSkills.filter(s => s !== '__none__').length} of ${availableSkills.length} skills enabled`}
                        </div>
                      </div>

                      {/* Visibility */}
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Visibility</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            className={`btn btn-sm ${gs.showInSidebar ? 'btn-blue' : 'btn-outline'}`}
                            onClick={() => updateSetting({ showInSidebar: !gs.showInSidebar })}
                          >
                            {gs.showInSidebar ? 'In Sidebar' : 'Hidden'}
                          </button>
                          <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                            {gs.showInSidebar ? 'Visible in chat sidebar' : 'Only in Settings & Overview'}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Tokens ── */}
      {section === 'tokens' && isOwner && (
        <>
          {/* Created token banner */}
          {createdToken && (
            <div style={{ margin: '0 16px 12px', padding: '12px 14px', background: 'var(--green-bg)', borderRadius: 'var(--r)', fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--green)' }}>Token created — share it now (won't be shown again)</div>
              <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', color: 'var(--text)', userSelect: 'all' }}>{createdToken}</div>
              <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-blue" onClick={() => copyToken(createdToken)}>
                  {copiedToken === createdToken ? 'Copied!' : 'Copy'}
                </button>
                <button className="btn btn-sm btn-outline" onClick={() => setCreatedToken(null)}>Dismiss</button>
              </div>
            </div>
          )}

          <div style={{ padding: '0 16px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="section-label" style={{ padding: 0 }}>Access Tokens</div>
            <button className="btn btn-sm btn-blue" onClick={() => setShowCreate(!showCreate)}>
              {showCreate ? 'Cancel' : '+ New Token'}
            </button>
          </div>

          {/* Create form */}
          {showCreate && (
            <div style={{ margin: '0 16px 12px', padding: 14, background: 'var(--surface)', borderRadius: 'var(--r)' }}>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Name</label>
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. Arun"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 14 }}
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Role</label>
                <input
                  value={newRole}
                  onChange={e => setNewRole(e.target.value)}
                  placeholder="e.g. developer, viewer"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 14 }}
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>
                  Groups {newGroups.length === 0 ? '(all — full access)' : `(${newGroups.length} selected)`}
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {groups.map(g => (
                    <button
                      key={g.jid}
                      className={`btn btn-sm ${newGroups.includes(g.jid) ? 'btn-blue' : 'btn-outline'}`}
                      onClick={() => toggleGroup(g.jid)}
                    >
                      {g.name}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={newCanSend}
                  onChange={e => setNewCanSend(e.target.checked)}
                  id="canSend"
                />
                <label htmlFor="canSend" style={{ fontSize: 13 }}>Can send messages</label>
              </div>
              <button className="btn btn-blue" onClick={handleCreate} disabled={!newName.trim()}>
                Create Token
              </button>
            </div>
          )}

          {/* Token list */}
          <div className="list-group">
            {tokens.map(t => (
              <div key={t.tokenFull} className="list-item" style={{ cursor: 'default' }}>
                <div className="list-content">
                  <div className="list-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {t.name}
                    {t.isOwner && <span className="badge badge-green" style={{ fontSize: 9 }}>owner</span>}
                    {!t.canSend && <span className="badge badge-orange" style={{ fontSize: 9 }}>read-only</span>}
                  </div>
                  <div className="list-subtitle">
                    {t.role || 'no role'} &middot; {t.token} &middot; {fmtDate(t.createdAt)}
                  </div>
                  {t.allowedGroups.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--purple)', marginTop: 2 }}>
                      {t.allowedGroups.map(jid => {
                        const g = groups.find(g => g.jid === jid);
                        return g?.name || jid;
                      }).join(', ')}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12 }}>
                    <span style={{ color: 'var(--text3)' }}>Reminders →</span>
                    <select
                      style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--separator)', background: 'var(--bg)', color: 'var(--text)' }}
                      value={t.reminderGroupJid || ''}
                      onChange={async (e) => {
                        await api.updateTokenReminderGroup(t.tokenFull, e.target.value || null);
                        api.getTokens().then(r => { if (r.ok) setTokens(r.data); });
                      }}
                    >
                      <option value="">Auto (main group)</option>
                      {groups.map(g => <option key={g.jid} value={g.jid}>{g.name}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={() => copyToken(t.tokenFull)}
                  >
                    {copiedToken === t.tokenFull ? 'Copied!' : 'Copy'}
                  </button>
                  {!t.isOwner && (
                    <button
                      className="btn btn-sm btn-red"
                      onClick={() => handleDelete(t.tokenFull, t.name)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
            {tokens.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                No tokens yet
              </div>
            )}
          </div>
        </>
      )}

      {/* ── mem0 ── */}
      {section === 'mem0' && (
        <>
          {mem0 && (
            <div className="card-grid">
              <div className="card stat-card">
                <div className="value">{privateMemories.length}</div>
                <div className="label">Private</div>
              </div>
              <div className="card stat-card">
                <div className="value">{sharedMemories.length}</div>
                <div className="label">Shared</div>
              </div>
              <div className="card stat-card">
                <div className="value">{memories.length}</div>
                <div className="label">Total</div>
              </div>
              <div className="card stat-card">
                <div className="value">{mem0.dbSize}</div>
                <div className="label">DB Size</div>
              </div>
            </div>
          )}

          {/* Scopes section */}
          {isOwner && (
            <>
              <div style={{ padding: '0 20px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="section-label" style={{ padding: 0 }}>Scopes</div>
                <button className="btn btn-sm btn-blue" onClick={() => setShowScopeCreate(!showScopeCreate)}>
                  {showScopeCreate ? 'Cancel' : '+ New Scope'}
                </button>
              </div>

              {showScopeCreate && (
                <div style={{ margin: '0 16px 12px', padding: 14, background: 'var(--surface)', borderRadius: 'var(--r)' }}>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Name</label>
                    <input
                      value={newScopeName}
                      onChange={e => setNewScopeName(e.target.value)}
                      placeholder="e.g. railmaster-public"
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 14 }}
                    />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Description</label>
                    <input
                      value={newScopeDesc}
                      onChange={e => setNewScopeDesc(e.target.value)}
                      placeholder="e.g. Game info, package name, Discord"
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 14 }}
                    />
                  </div>
                  <button className="btn btn-blue" onClick={handleCreateScope} disabled={!newScopeName.trim() || !newScopeDesc.trim()}>
                    Create Scope
                  </button>
                </div>
              )}

              <div style={{ padding: '0 16px 12px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {scopes.map(s => (
                  <div key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: 'var(--surface)', borderRadius: 8, fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>{s.name}</span>
                    <span style={{ color: 'var(--text2)', fontSize: 11 }}>{s.description}</span>
                    <span
                      className="mi"
                      style={{ fontSize: 14, color: 'var(--text3)', cursor: 'pointer', marginLeft: 4 }}
                      onClick={() => handleDeleteScope(s.name)}
                    >close</span>
                  </div>
                ))}
                {scopes.length === 0 && !showScopeCreate && (
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>No scopes yet — create one to start organizing shared memories</span>
                )}
              </div>
            </>
          )}

          {/* Memories list */}
          {isOwner && memories.length > 0 && (
            <>
              <div style={{ padding: '0 20px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="section-label" style={{ padding: 0 }}>All Memories</div>
                <div className="segmented">
                  <button className={`seg-btn ${memoryFilter === 'all' ? 'active' : ''}`} onClick={() => setMemoryFilter('all')}>All</button>
                  <button className={`seg-btn ${memoryFilter === 'private' ? 'active' : ''}`} onClick={() => setMemoryFilter('private')}>Private</button>
                  <button className={`seg-btn ${memoryFilter === 'shared' ? 'active' : ''}`} onClick={() => setMemoryFilter('shared')}>Shared</button>
                </div>
              </div>
              <div className="list-group">
                {filteredMemories.map(m => {
                  const isShared = m.metadata?._userId === 'shared';
                  const scopeLabel = isShared
                    ? (typeof m.metadata?.scope === 'string' ? m.metadata.scope : Array.isArray(m.metadata?.scope) ? (m.metadata.scope as string[]).join(', ') : 'unscoped')
                    : 'private';

                  return (
                  <div key={m.id} className="list-item" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <div className="list-content">
                        <div className="list-title" style={{ fontSize: 13, lineHeight: 1.4 }}>
                          {m.memory.length > 120 ? m.memory.slice(0, 117) + '...' : m.memory}
                        </div>
                        <div className="list-subtitle">
                          {m.id.slice(0, 8)}
                          {m.metadata?.groupFolder && ` \u00B7 from: ${m.metadata.groupFolder}`}
                          {isShared && ' \u00B7 shared'}
                        </div>
                      </div>
                      <span
                        className={`badge ${isShared ? 'badge-green' : 'badge-blue'}`}
                        style={{ cursor: 'pointer', flexShrink: 0 }}
                        onClick={() => setEditingMemory(editingMemory === m.id ? null : m.id)}
                      >
                        {scopeLabel}
                      </span>
                    </div>

                    {/* Actions */}
                    {editingMemory === m.id && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '4px 0' }}>
                        {!isShared && scopes.length > 0 && (
                          <button
                            className="btn btn-sm btn-blue"
                            onClick={() => handleMoveToShared(m)}
                            disabled={moveLoading && movingMemory === m.id}
                          >
                            {moveLoading && movingMemory === m.id ? 'Suggesting...' : 'Move to Shared'}
                          </button>
                        )}
                        {isShared && scopes.map(s => (
                          <button
                            key={s.name}
                            className={`btn btn-sm ${scopeLabel === s.name ? 'btn-blue' : 'btn-outline'}`}
                            onClick={async () => {
                              await api.updateMemoryScope(m.id, s.name);
                              api.getMemories().then(r => { if (r.ok) setMemories(r.data); });
                              setEditingMemory(null);
                            }}
                          >{s.name}</button>
                        ))}
                        <button
                          className="btn btn-sm btn-red"
                          onClick={async () => { if (confirm('Delete this memory?')) { await api.deleteMemory(m.id); setMemories(prev => prev.filter(x => x.id !== m.id)); setEditingMemory(null); } }}
                        >Delete</button>
                      </div>
                    )}

                    {/* Move-to-shared confirmation */}
                    {movingMemory === m.id && !moveLoading && (
                      <div style={{ padding: '6px 0', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, color: 'var(--text2)' }}>Move to scope:</span>
                        {scopes.map(s => (
                          <button
                            key={s.name}
                            className={`btn btn-sm ${suggestedScope === s.name ? 'btn-blue' : 'btn-outline'}`}
                            onClick={() => confirmMoveToShared(m.id, s.name)}
                          >
                            {s.name}{suggestedScope === s.name ? ' (suggested)' : ''}
                          </button>
                        ))}
                        <button
                          className="btn btn-sm btn-outline"
                          onClick={() => { setMovingMemory(null); setSuggestedScope(null); }}
                        >Cancel</button>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
      {section === 'mem0' && !mem0 && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>Loading...</div>}

      {/* ── Logs ── */}
      {section === 'logs' && (
        <>
          <div className="logs-toolbar">
            <select value={folder} onChange={e => setFolder(e.target.value)}>
              {groups.map(g => <option key={g.folder} value={g.folder}>{g.name}</option>)}
            </select>
          </div>
          {/* Live terminal — always visible */}
          <div style={{ margin: '0 12px 12px', borderRadius: '0.75rem', overflow: 'hidden', border: '1px solid rgba(108,60,225,0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: 'rgba(108,60,225,0.08)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', marginRight: 6, animation: 'pulse 1.5s infinite' }} />
                Live Output
              </span>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>{(containerLogs[folder] || []).length} / 10 lines</span>
            </div>
            <div style={{ background: '#0d0d0d', padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6, minHeight: 140, maxHeight: 400, overflowY: 'auto' }}>
              {(containerLogs[folder] || []).length === 0
                ? <span style={{ color: '#475569' }}>Waiting for logs...</span>
                : (containerLogs[folder] || []).map((entry, i) => (
                  <div key={i} style={{ color: entry.stream === 'stderr' ? '#a3e635' : '#e2e8f0', wordBreak: 'break-all' }}>
                    <span style={{ color: '#475569', marginRight: 8 }}>{entry.ts}</span>
                    {entry.line}
                  </div>
                ))
              }
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return s; }
}
