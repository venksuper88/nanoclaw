import { useEffect, useState } from 'react';
import { api } from '../api';
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

interface EmailRuleRow {
  id: string;
  name: string;
  priority: number;
  from_pattern: string;
  subject_pattern: string;
  body_pattern: string;
  email_type_pattern: string;
  action: string;
  target_group: string;
  command_name: string;
  extract_prompt: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// Email types loaded dynamically from registered schemas

export function SettingsView({ groups }: { groups: Group[] }) {
  const [section, setSection] = useState<'groups' | 'tokens' | 'mem0' | 'email'>('groups');

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
  const [groupSettings, setGroupSettings] = useState<Record<string, { memoryMode: string; memoryScopes: string[]; memoryUserId: string; isTransient: boolean; showInSidebar: boolean; idleTimeoutMinutes: number | null; allowedSkills: string[]; allowedMcpServers: string[]; model: string; contextWindow: string; tokens: Array<{ name: string; role: string; isOwner: boolean }> }>>({});
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<Array<{ name: string; type: string }>>([]);

  // Scope definitions
  const [scopes, setScopes] = useState<ScopeDef[]>([]);
  const [showScopeCreate, setShowScopeCreate] = useState(false);
  const [newScopeName, setNewScopeName] = useState('');
  const [newScopeDesc, setNewScopeDesc] = useState('');

  // Email rules state
  const [emailTypes, setEmailTypes] = useState<string[]>(['Other']);
  const [emailRules, setEmailRules] = useState<EmailRuleRow[]>([]);
  const [emailLog, setEmailLog] = useState<Array<{ sender: string; subject: string; rule_name: string | null; action: string; target_group: string | null; processed_at: string; email_type: string | null }>>([]);
  const [extractionStats, setExtractionStats] = useState<{ today: { calls: number; input_tokens: number; output_tokens: number }; week: { calls: number; input_tokens: number; output_tokens: number }; total: { calls: number; input_tokens: number; output_tokens: number }; byType: Record<string, number> } | null>(null);
  const [showRuleCreate, setShowRuleCreate] = useState(false);
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState({ name: '', priority: 100, from_pattern: '', subject_pattern: '', body_pattern: '', email_type_pattern: '', action: 'forward' as 'forward' | 'archive' | 'discard' | 'command', target_group: '', command_name: '', extract_prompt: '', enabled: true });

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
        setAvailableSkills(r.data.map((s: { name: string }) => s.name));
      }
    }).catch(() => {});
    api.getMcpServers().then(r => {
      if (r.ok) setAvailableMcpServers(r.data);
    }).catch(() => {});
  }, []);

  // Load email rules
  useEffect(() => {
    if (section !== 'email' || !isOwner) return;
    api.getEmailTypes().then(r => { if (r.ok) setEmailTypes(r.data); }).catch(() => {});
    api.getEmailRules().then(r => { if (r.ok) setEmailRules(r.data); }).catch(() => {});
    api.getEmailLog().then(r => { if (r.ok) setEmailLog(r.data); }).catch(() => {});
    api.getExtractionStats().then(r => { if (r.ok) setExtractionStats(r.data); }).catch(() => {});
  }, [section, isOwner]);

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
          {isOwner && <button className={`seg-btn ${section === 'email' ? 'active' : ''}`} onClick={() => setSection('email')}>Email</button>}
          {isOwner && <button className={`seg-btn ${section === 'tokens' ? 'active' : ''}`} onClick={() => setSection('tokens')}>Access</button>}
          <button className={`seg-btn ${section === 'mem0' ? 'active' : ''}`} onClick={() => setSection('mem0')}>Memory</button>
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

              const updateSetting = async (update: { memoryMode?: string; memoryScopes?: string[]; memoryUserId?: string; isTransient?: boolean; showInSidebar?: boolean; idleTimeoutMinutes?: number | null; allowedSkills?: string[]; allowedMcpServers?: string[]; model?: string; contextWindow?: string }) => {
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
                      {/* Model */}
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Model</div>
                        <div className="segmented">
                          <button className={`seg-btn ${(gs.model || 'opus') === 'opus' ? 'active' : ''}`} onClick={() => updateSetting({ model: 'opus' })}>Opus</button>
                          <button className={`seg-btn ${gs.model === 'sonnet' ? 'active' : ''}`} onClick={() => updateSetting({ model: 'sonnet' })}>Sonnet</button>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                          {(gs.model || 'opus') === 'opus' ? 'Most capable — deep reasoning, complex tasks' : 'Fast and efficient — simpler tasks, lower cost'}
                        </div>
                      </div>

                      {/* Context Window */}
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Context Window</div>
                        <div className="segmented">
                          <button className={`seg-btn ${(gs.contextWindow || '200k') === '200k' ? 'active' : ''}`} onClick={() => updateSetting({ contextWindow: '200k' })}>200K</button>
                          <button className={`seg-btn ${gs.contextWindow === '1m' ? 'active' : ''}`} onClick={() => updateSetting({ contextWindow: '1m' })}>1M</button>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                          {gs.contextWindow === '1m' ? '1M tokens — fewer compactions, longer conversations. Requires /new to take effect.' : '200K tokens — standard context window'}
                        </div>
                      </div>

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

                      {/* MCP Servers */}
                      {availableMcpServers.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>MCP Servers</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {availableMcpServers.map(srv => {
                            const allowed = gs.allowedMcpServers || [];
                            const isAllMode = allowed.includes('__all__');
                            const isEnabled = isAllMode || allowed.includes(srv.name);
                            return (
                              <button key={srv.name}
                                className={`btn btn-sm ${isEnabled ? 'btn-blue' : 'btn-outline'}`}
                                title={`${srv.name} (${srv.type})`}
                                onClick={() => {
                                  if (isAllMode) {
                                    // Switch from all to all-except-this
                                    updateSetting({ allowedMcpServers: availableMcpServers.filter(s => s.name !== srv.name).map(s => s.name) });
                                  } else if (isEnabled) {
                                    const next = allowed.filter(s => s !== srv.name && s !== '__all__');
                                    updateSetting({ allowedMcpServers: next });
                                  } else {
                                    const next = [...allowed.filter(s => s !== '__all__'), srv.name];
                                    updateSetting({ allowedMcpServers: next.length >= availableMcpServers.length ? ['__all__'] : next });
                                  }
                                }}
                              >{srv.name}</button>
                            );
                          })}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                          {(gs.allowedMcpServers || []).length === 0 ? 'nanoclaw only — no global MCP servers' :
                           (gs.allowedMcpServers || []).includes('__all__') ? 'All global MCP servers enabled' :
                           `${(gs.allowedMcpServers || []).length} of ${availableMcpServers.length} enabled`}
                        </div>
                      </div>
                      )}

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

      {/* ── Email Rules ── */}
      {section === 'email' && isOwner && (
        <>
          {/* Extraction Stats */}
          {extractionStats && extractionStats.total.calls > 0 && (
            <div className="card-grid">
              <div className="card stat-card">
                <div className="value">{extractionStats.today.calls}</div>
                <div className="label">Today</div>
              </div>
              <div className="card stat-card">
                <div className="value">{extractionStats.week.calls}</div>
                <div className="label">This Week</div>
              </div>
              <div className="card stat-card">
                <div className="value">{extractionStats.total.calls}</div>
                <div className="label">Total Calls</div>
              </div>
              <div className="card stat-card">
                <div className="value">{((extractionStats.total.input_tokens + extractionStats.total.output_tokens) / 1000).toFixed(1)}K</div>
                <div className="label">Tokens Used</div>
              </div>
            </div>
          )}
          {extractionStats && extractionStats.total.calls > 0 && Object.keys(extractionStats.byType).length > 0 && (
            <div style={{ padding: '0 16px 12px', display: 'flex', gap: 6 }}>
              {Object.entries(extractionStats.byType).map(([type, count]) => (
                <span key={type} className={`badge ${type === 'email' ? 'badge-blue' : type === 'image' ? 'badge-green' : 'badge-orange'}`}>
                  {type}: {count}
                </span>
              ))}
            </div>
          )}

          <div style={{ padding: '0 16px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="section-label" style={{ padding: 0 }}>Email Routing Rules</div>
            <button className="btn btn-sm btn-blue" onClick={() => {
              setRuleForm({ name: '', priority: (emailRules.length + 1) * 10, from_pattern: '', subject_pattern: '', body_pattern: '', email_type_pattern: '', action: 'forward', target_group: '', command_name: '', extract_prompt: '', enabled: true });
              setShowRuleCreate(!showRuleCreate);
              setEditingRule(null);
            }}>
              {showRuleCreate && !editingRule ? 'Cancel' : '+ New Rule'}
            </button>
          </div>

          <div style={{ padding: '0 16px 12px', fontSize: 12, color: 'var(--text2)' }}>
            Rules are checked in priority order (lowest first). First match wins. Unmatched emails go to the main group.
          </div>

          {/* Create / Edit form */}
          {(showRuleCreate || editingRule) && (
            <div style={{ margin: '0 16px 12px', padding: 14, background: 'var(--surface)', borderRadius: 'var(--r)' }}>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Name</label>
                <input value={ruleForm.name} onChange={e => setRuleForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. AppLovin reports" style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 14 }} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>From Pattern</label>
                  <input value={ruleForm.from_pattern} onChange={e => setRuleForm(f => ({ ...f, from_pattern: e.target.value }))} placeholder="*@applovin.com" style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }} />
                </div>
                <div style={{ width: 70 }}>
                  <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Priority</label>
                  <input type="number" value={ruleForm.priority} onChange={e => setRuleForm(f => ({ ...f, priority: parseInt(e.target.value) || 0 }))} style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }} />
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Subject Pattern</label>
                <input value={ruleForm.subject_pattern} onChange={e => setRuleForm(f => ({ ...f, subject_pattern: e.target.value }))} placeholder="*revenue*" style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Body Contains (keyword)</label>
                <input value={ruleForm.body_pattern} onChange={e => setRuleForm(f => ({ ...f, body_pattern: e.target.value }))} placeholder="optional keyword in body" style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Email Type (empty = any type)</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {emailTypes.map(type => {
                    const selected = ruleForm.email_type_pattern.split(',').map(t => t.trim()).filter(Boolean);
                    const isSelected = selected.includes(type);
                    return (
                      <button key={type} className={`btn btn-sm ${isSelected ? 'btn-blue' : 'btn-outline'}`} onClick={() => {
                        const next = isSelected ? selected.filter(t => t !== type) : [...selected, type];
                        setRuleForm(f => ({ ...f, email_type_pattern: next.join(',') }));
                      }}>
                        {type}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3 }}>Select which email types this rule matches. Combined with pattern filters below.</div>
              </div>
              {ruleForm.action === 'forward' && (
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Extract Prompt (optional — guides Gemini summarization)</label>
                  <input value={ruleForm.extract_prompt} onChange={e => setRuleForm(f => ({ ...f, extract_prompt: e.target.value }))} placeholder="e.g. Extract: merchant, amount, currency, date, invoice number" style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }} />
                  <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3 }}>Empty = default summarization. Set a prompt to guide what Gemini extracts.</div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Action</label>
                  <div className="segmented">
                    <button className={`seg-btn ${ruleForm.action === 'forward' ? 'active' : ''}`} onClick={() => setRuleForm(f => ({ ...f, action: 'forward' }))}>Forward</button>
                    <button className={`seg-btn ${ruleForm.action === 'archive' ? 'active' : ''}`} onClick={() => setRuleForm(f => ({ ...f, action: 'archive' }))}>Archive</button>
                    <button className={`seg-btn ${ruleForm.action === 'discard' ? 'active' : ''}`} onClick={() => setRuleForm(f => ({ ...f, action: 'discard' }))}>Discard</button>
                  </div>
                </div>
              </div>
              {ruleForm.action === 'forward' && (
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>Target Group</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {groups.map(g => (
                      <button key={g.folder} className={`btn btn-sm ${ruleForm.target_group === g.folder ? 'btn-blue' : 'btn-outline'}`} onClick={() => setRuleForm(f => ({ ...f, target_group: g.folder }))}>
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-blue" disabled={!ruleForm.name.trim()} onClick={async () => {
                  if (editingRule) {
                    await api.updateEmailRule(editingRule, ruleForm);
                  } else {
                    await api.createEmailRule(ruleForm);
                  }
                  setShowRuleCreate(false);
                  setEditingRule(null);
                  api.getEmailRules().then(r => { if (r.ok) setEmailRules(r.data); });
                }}>
                  {editingRule ? 'Save Changes' : 'Create Rule'}
                </button>
                {editingRule && <button className="btn btn-outline" onClick={() => { setEditingRule(null); setShowRuleCreate(false); }}>Cancel</button>}
              </div>
            </div>
          )}

          {/* Rules list */}
          <div className="list-group">
            {emailRules.map(rule => (
              <div key={rule.id} className="list-item" style={{ cursor: 'default', opacity: rule.enabled ? 1 : 0.5 }}>
                <div style={{ width: 32, height: 32, borderRadius: 10, background: rule.action === 'forward' ? 'var(--purple)' : rule.action === 'archive' ? 'var(--text3)' : '#e74c3c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="mi" style={{ fontSize: 16, color: 'white' }}>
                    {rule.action === 'forward' ? 'forward_to_inbox' : rule.action === 'archive' ? 'archive' : 'delete'}
                  </span>
                </div>
                <div className="list-content">
                  <div className="list-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {rule.name}
                    <span className="badge" style={{ fontSize: 9, background: 'var(--bg)' }}>#{rule.priority}</span>
                  </div>
                  <div className="list-subtitle">
                    {rule.email_type_pattern && `type: ${rule.email_type_pattern}`}
                    {rule.email_type_pattern && (rule.from_pattern || rule.subject_pattern || rule.body_pattern) && ' · '}
                    {rule.from_pattern && `from: ${rule.from_pattern}`}
                    {rule.from_pattern && rule.subject_pattern && ' · '}
                    {rule.subject_pattern && `subj: ${rule.subject_pattern}`}
                    {rule.body_pattern && ` · body: "${rule.body_pattern}"`}
                    {!rule.from_pattern && !rule.subject_pattern && !rule.body_pattern && !rule.email_type_pattern && 'matches all emails'}
                    {rule.action === 'forward' && ` → ${groups.find(g => g.folder === rule.target_group)?.name || rule.target_group}`}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className={`btn btn-sm ${rule.enabled ? 'btn-outline' : 'btn-blue'}`} onClick={async () => {
                    await api.updateEmailRule(rule.id, { enabled: !rule.enabled });
                    api.getEmailRules().then(r => { if (r.ok) setEmailRules(r.data); });
                  }}>
                    {rule.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-sm btn-outline" onClick={() => {
                    setRuleForm({ name: rule.name, priority: rule.priority, from_pattern: rule.from_pattern, subject_pattern: rule.subject_pattern, body_pattern: rule.body_pattern, email_type_pattern: rule.email_type_pattern || '', action: rule.action as any, target_group: rule.target_group, command_name: (rule as any).command_name || '', extract_prompt: rule.extract_prompt || '', enabled: rule.enabled });
                    setEditingRule(rule.id);
                    setShowRuleCreate(false);
                  }}>
                    Edit
                  </button>
                  <button className="btn btn-sm btn-red" onClick={async () => {
                    if (!confirm(`Delete rule "${rule.name}"?`)) return;
                    await api.deleteEmailRule(rule.id);
                    api.getEmailRules().then(r => { if (r.ok) setEmailRules(r.data); });
                  }}>
                    <span className="mi" style={{ fontSize: 14 }}>delete</span>
                  </button>
                </div>
              </div>
            ))}
            {emailRules.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                No email rules yet. Unmatched emails go to the main group (PO).
              </div>
            )}
          </div>

          {/* Activity Log */}
          <div style={{ padding: '12px 16px 8px' }}>
            <div className="section-label" style={{ padding: 0 }}>Recent Activity</div>
          </div>
          <div className="list-group">
            {emailLog.map((entry, i) => (
              <div key={i} className="list-item" style={{ cursor: 'default', padding: '8px 16px' }}>
                <div style={{ width: 24, height: 24, borderRadius: 8, background: entry.action === 'forward' ? 'var(--purple)' : entry.action === 'fallback' ? 'var(--text3)' : entry.action === 'archive' ? '#f39c12' : '#e74c3c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="mi" style={{ fontSize: 14, color: 'white' }}>
                    {entry.action === 'forward' ? 'forward_to_inbox' : entry.action === 'fallback' ? 'inbox' : entry.action === 'archive' ? 'archive' : 'delete'}
                  </span>
                </div>
                <div className="list-content">
                  <div className="list-title" style={{ fontSize: 12 }}>
                    {entry.subject.length > 50 ? entry.subject.slice(0, 47) + '...' : entry.subject}
                  </div>
                  <div className="list-subtitle" style={{ fontSize: 11 }}>
                    {entry.sender}
                    {entry.email_type ? ` · ${entry.email_type}` : ''}
                    {entry.rule_name ? ` · rule: ${entry.rule_name}` : ' · no match'}
                    {entry.target_group ? ` → ${groups.find(g => g.folder === entry.target_group)?.name || entry.target_group}` : ''}
                    {' · '}{fmtDate(entry.processed_at)}
                  </div>
                </div>
                <span className={`badge ${entry.action === 'forward' ? 'badge-green' : entry.action === 'fallback' ? 'badge-blue' : entry.action === 'archive' ? 'badge-orange' : 'badge-red'}`} style={{ fontSize: 9 }}>
                  {entry.action}
                </span>
              </div>
            ))}
            {emailLog.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                No emails processed yet.
              </div>
            )}
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
    </div>
  );
}

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return s; }
}
