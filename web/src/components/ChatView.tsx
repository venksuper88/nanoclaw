import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';
import { renderMarkdown } from '../markdown';
import { MediaViewer } from './MediaViewer';
import type { Group } from '../App';

interface Message {
  id: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
  isStateless?: boolean;
}

interface Props {
  groups: Group[];
  selectedJid: string | null;
  selectedGroup: Group | undefined;
  processingFolders: Set<string>;
  onSelectGroup: (jid: string | null) => void;
  connected: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  messageCache: Record<string, any[]>;
  setMessageCache: (fn: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  reconnectKey: number;
}

interface CommandArg { name: string; description?: string; required?: boolean; }
interface Command { command: string; description: string; prefix?: string; args?: CommandArg[]; }

const COLORS = ['#C4B5E3','#A5D6A7','#FFD54F','#90CAF9','#CE93D8','#F48FB1','#80CBC4','#FFAB91'];
function avatarColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ChatView({ groups, selectedJid, selectedGroup, processingFolders, onSelectGroup, connected, drawerOpen, onToggleDrawer, messageCache, setMessageCache, reconnectKey }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [stateless, setStateless] = useState(false);
  const [commands, setCommands] = useState<Command[]>([]);
  const [showCommands, setShowCommands] = useState(false);
  const [cmdFilter, setCmdFilter] = useState('');
  const [cmdPrefix, setCmdPrefix] = useState('/');
  const [selectedCmd, setSelectedCmd] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cmdMenuRef = useRef<HTMLDivElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [viewingMedia, setViewingMedia] = useState<{ url: string; filename: string; type: 'image' | 'video' | 'pdf' } | null>(null);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [containerLogs, setContainerLogs] = useState<string[]>([]);
  const [logsVisible, setLogsVisible] = useState(false);
  const [copiedToast, setCopiedToast] = useState(false);
  const PAGE_SIZE = 50;

  useEffect(() => {
    api.getCommands(selectedGroup?.folder).then(r => { if (r.ok) setCommands(r.data); }).catch(() => {});
  }, [selectedGroup?.folder]);

  useEffect(() => {
    if (!showCommands) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (cmdMenuRef.current?.contains(target)) return;
      if (inputRef.current?.contains(target)) return;
      setShowCommands(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('touchstart', handler); };
  }, [showCommands]);

  useEffect(() => {
    setContainerLogs([]);
    setLogsVisible(false);
  }, [selectedJid]);

  useEffect(() => {
    if (!selectedJid) return;
    const cached = messageCache[selectedJid];
    if (cached && cached.length > 0) {
      setMessages(cached);
      setHasMore(cached.length >= PAGE_SIZE);
    } else {
      setMessages([]);
      setHasMore(true);
    }
    api.getMessages(selectedJid, PAGE_SIZE).then(r => {
      if (r.ok) {
        setMessages(r.data);
        setHasMore(r.data.length >= PAGE_SIZE);
        setMessageCache(prev => ({ ...prev, [selectedJid]: r.data }));
      }
    }).catch(() => {});
  }, [selectedJid]);

  // Refresh messages on socket reconnect — catches messages emitted before client was connected
  useEffect(() => {
    if (!selectedJid || reconnectKey === 0) return;
    api.getMessages(selectedJid, PAGE_SIZE).then(r => {
      if (r.ok) {
        setMessages(r.data);
        setMessageCache(prev => ({ ...prev, [selectedJid]: r.data }));
        scrollToBottom();
      }
    }).catch(() => {});
  }, [reconnectKey]);

  // Refresh messages when app returns to foreground (iOS kills WS in background)
  useEffect(() => {
    if (!selectedJid) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        api.getMessages(selectedJid, PAGE_SIZE).then(r => {
          if (r.ok) {
            setMessages(r.data);
            setMessageCache(prev => ({ ...prev, [selectedJid]: r.data }));
          }
        }).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [selectedJid]);

  useEffect(() => {
    const socket = getSocket();
    const onMsg = (d: { chatJid: string; senderName: string; content: string; timestamp: string; isFromMe: boolean; isBotMessage?: boolean; isStreamed?: boolean }) => {
      if (d.chatJid === selectedJid) {
        // Deduplicate: skip if we already have a message with same content + similar timestamp (from optimistic add)
        setMessages(p => {
          const isDupe = p.some(m => m.content === d.content && Math.abs(new Date(m.timestamp).getTime() - new Date(d.timestamp).getTime()) < 3000);
          if (isDupe) return p;
          const newMsg = { id: `rt-${Date.now()}`, senderName: d.senderName, content: d.content, timestamp: d.timestamp, isFromMe: d.isFromMe, isBotMessage: d.isBotMessage || false };
          setMessageCache(prev => ({ ...prev, [d.chatJid]: [...(prev[d.chatJid] || []), newMsg] }));
          return [...p, newMsg];
        });
      }
    };
    const onOut = (d: { groupFolder: string; text: string }) => {
      if (selectedGroup && d.groupFolder === selectedGroup.folder) {
        // Deduplicate: skip if streaming already added this message via message:new
        setMessages(p => {
          const isDupe = p.some(m => m.content === d.text && Math.abs(new Date(m.timestamp).getTime() - Date.now()) < 10000);
          if (isDupe) return p;
          const newMsg = { id: `ag-${Date.now()}`, senderName: selectedGroup.name, content: d.text, timestamp: new Date().toISOString(), isFromMe: false, isBotMessage: true };
          if (selectedJid) setMessageCache(prev => ({ ...prev, [selectedJid]: [...(prev[selectedJid] || []), newMsg] }));
          scrollToBottom();
          return [...p, newMsg];
        });
      }
    };
    socket.on('message:new', onMsg);
    socket.on('agent:output', onOut);
    return () => {
      socket.off('message:new', onMsg);
      socket.off('agent:output', onOut);
    };
  }, [selectedJid, selectedGroup]);

  const processing = selectedGroup ? processingFolders.has(selectedGroup.folder) : false;

  // Scroll to bottom — always instant, no animation
  const scrollToBottom = () => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Position at bottom on render — like Telegram, no visible scroll
  const skipAutoScroll = useRef(false);
  useLayoutEffect(() => {
    if (skipAutoScroll.current) {
      skipAutoScroll.current = false;
      return;
    }
    scrollToBottom();
  }, [messages]);

  // Scroll down when "is thinking" appears
  useEffect(() => {
    if (processing) scrollToBottom();
  }, [processing]);

  // Load older on scroll to top
  const loadingRef = useRef(false);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // Show scroll-down button when not near bottom
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollDown(distFromBottom > 200);

      if (el.scrollTop < 80 && hasMore && !loadingRef.current) {
        loadingRef.current = true;
        setLoadingMore(true);
        const prevH = el.scrollHeight;
        const prevS = el.scrollTop;
        api.getMessages(selectedJid!, PAGE_SIZE + messages.length).then(r => {
          if (r.ok) {
            const ids = new Set(messages.map(m => m.id));
            const older = r.data.filter((m: any) => !ids.has(m.id));
            if (older.length === 0) {
              setHasMore(false);
            } else {
              skipAutoScroll.current = true;
              setMessages(prev => [...older, ...prev]);
              requestAnimationFrame(() => {
                el.scrollTop = prevS + (el.scrollHeight - prevH);
              });
            }
          }
          setLoadingMore(false);
          loadingRef.current = false;
        }).catch(() => { setLoadingMore(false); loadingRef.current = false; });
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [selectedJid, messages.length, hasMore]);

  // Keyboard open — scroll to bottom after layout settles
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prev = vv.height;
    const onResize = () => {
      if (vv.height < prev - 50) {
        setTimeout(scrollToBottom, 100);
      }
      prev = vv.height;
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // Live draft sync from other devices
  useEffect(() => {
    const socket = getSocket();
    const handler = (d: { chatJid: string; content: string }) => {
      if (d.chatJid !== selectedJid) return;
      // Skip if input is focused — user is actively typing, don't reset their cursor
      if (inputRef.current && document.activeElement === inputRef.current) return;
      setInput(d.content);
      if (inputRef.current) (inputRef.current as any).innerText = d.content;
    };
    socket.on('draft:update', handler);
    return () => { socket.off('draft:update', handler); };
  }, [selectedJid]);

  // Load draft when switching groups
  useEffect(() => {
    if (!selectedJid) return;
    api.getDraft(selectedJid).then(r => {
      if (r.ok && r.data.content) {
        setInput(r.data.content);
        if (inputRef.current) (inputRef.current as any).innerText = r.data.content;
      } else {
        setInput('');
        if (inputRef.current) (inputRef.current as any).innerText = '';
      }
    }).catch(() => {});
  }, [selectedJid]);

  // Debounced draft save
  const saveDraft = useCallback((jid: string, val: string) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      api.setDraft(jid, val).catch(() => {});
    }, 800);
  }, []);

  const onInputChange = (val: string) => {
    setInput(val);
    if (selectedJid) saveDraft(selectedJid, val);
    if ((val.startsWith('/') || val.startsWith('!')) && !val.includes(' ')) {
      const prefix = val[0];
      const filter = val.slice(1).toLowerCase();
      setCmdFilter(filter);
      setCmdPrefix(prefix);
      setShowCommands(true);
      setSelectedCmd(0);
    } else {
      setShowCommands(false);
    }
  };

  const filteredCommands = showCommands ? commands.filter(c => {
    const matchesFilter = c.command.toLowerCase().includes(cmdFilter);
    if (cmdPrefix === '!') return matchesFilter && (c as any).prefix === '!';
    return matchesFilter && (c as any).prefix !== '!';
  }) : [];

  const selectCommand = (cmd: Command) => {
    const prefix = cmd.prefix || '/';
    const text = `${prefix}${cmd.command} `;
    setInput(text);
    if (inputRef.current) (inputRef.current as any).innerText = text;
    setShowCommands(false);
    inputRef.current?.focus();
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedCmd(i => { const n = Math.min(i+1, filteredCommands.length-1); cmdMenuRef.current?.children[n]?.scrollIntoView({ block: 'nearest' }); return n; }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedCmd(i => { const n = Math.max(i-1, 0); cmdMenuRef.current?.children[n]?.scrollIntoView({ block: 'nearest' }); return n; }); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && filteredCommands.length > 0)) { e.preventDefault(); selectCommand(filteredCommands[selectedCmd]); return; }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  };

  const addSystemMessage = (content: string) => {
    setMessages(p => [...p, { id: `sys-${Date.now()}`, senderName: 'System', content, timestamp: new Date().toISOString(), isFromMe: false, isBotMessage: true }]);
  };

  const send = async () => {
    const hasText = input.trim().length > 0;
    const hasFiles = stagedFiles.length > 0;
    if ((!hasText && !hasFiles) || !selectedJid || !selectedGroup || sending) return;
    setShowCommands(false);
    const t = input.trim();
    const files = [...stagedFiles];
    // Cancel any pending debounced draft save before clearing
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    setInput('');
    setStagedFiles([]);
    if (inputRef.current) (inputRef.current as any).innerText = '';
    if (selectedJid) api.setDraft(selectedJid, '').catch(() => {});

    setSending(true);

    // Upload files
    const uploadedNames: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        await api.uploadFile(selectedGroup.folder, fd);
        uploadedNames.push(file.name);
      } catch (err) {
        addSystemMessage(`Upload failed (${file.name}): ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    // Build message with file tags for successfully uploaded files
    const fileTags = uploadedNames.map(n => `[File: ${n}]`).join('\n');
    const msgText = fileTags
      ? (hasText ? `${fileTags}\n${t}` : fileTags)
      : t;

    // Don't send empty message (all uploads failed, no text)
    if (!msgText) { setSending(false); return; }

    setMessages(p => [...p, { id: `l-${Date.now()}`, senderName: 'You', content: msgText, timestamp: new Date().toISOString(), isFromMe: true, isBotMessage: false, isStateless: stateless }]);
    try { await api.sendChat(selectedJid, msgText, stateless || undefined); } catch {}
    setSending(false);
    if (stateless) setStateless(false); // Reset toggle after sending
    (inputRef.current as any)?.focus();
  };

  const stageFile = (newFiles: File[]) => {
    setStagedFiles(prev => [...prev, ...newFiles]);
    (inputRef.current as any)?.focus();
  };

  const upload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length) stageFile(Array.from(files));
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length) stageFile(Array.from(files));
  };

  // Parse [File: name], [Document: name | path:...], [Photo: name | path:...] from message content
  const parseMedia = (content: string, folder?: string): { type: 'image' | 'video' | 'pdf' | 'file' | null; filename: string; url: string; thumbUrl: string; text: string } => {
    // Match [File: x], [Document: x | path:y], [Photo: x | path:y]
    const match = content.match(/^\[(File|Document|Photo|Video):\s*([^\]|]+?)(?:\s*\|\s*path:([^\]]+))?\](.*)$/s);
    if (!match) return { type: null, filename: '', url: '', thumbUrl: '', text: content };
    const [, tag, filename, , rest] = match;
    const cleanName = filename.trim();
    const ext = cleanName.split('.').pop()?.toLowerCase() || '';
    const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
    const vidExts = ['mp4', 'webm', 'mov'];

    const f = folder || 'main';
    const base = `/api/files/${f}/${encodeURIComponent(cleanName)}`;
    const token = localStorage.getItem('nanoclaw_token') || '';
    const authUrl = `${base}?token=${token}`;
    const thumbUrl = `${base}?token=${token}&thumb=1`;

    const pdfExts = ['pdf'];

    let type: 'image' | 'video' | 'pdf' | 'file' | null = null;
    if (tag === 'Photo' || imgExts.includes(ext)) type = 'image';
    else if (tag === 'Video' || vidExts.includes(ext)) type = 'video';
    else if (pdfExts.includes(ext)) type = 'pdf';
    else type = 'file';

    return { type, filename: cleanName, url: authUrl, thumbUrl, text: rest.trim() };
  };

  const shouldShowHeader = (msg: Message, i: number): boolean => {
    if (i === 0) return true;
    const prev = messages[i - 1];
    return prev.senderName !== msg.senderName || prev.isBotMessage !== msg.isBotMessage;
  };

  const agentColor = selectedGroup ? avatarColor(selectedGroup.name) : '#C4B5E3';

  return (
    <div
      className={`chat-view ${dragOver ? 'drag-over' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
      onDrop={onDrop}
    >
      {/* Session divider */}
      <div className="session-divider">
        <span>Mission Session Start &bull; {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      {/* Messages */}
      <div className="chat-messages" ref={chatScrollRef}>
        {loadingMore && (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <span className="typing-dots"><span>.</span><span>.</span><span>.</span></span>
          </div>
        )}
        {!hasMore && messages.length > 0 && (
          <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 12, color: 'var(--text2)' }}>
            Beginning of conversation
          </div>
        )}
        {messages.map((msg, i) => {
          const isUser = msg.isBotMessage; // "bot" in our model = user sent from dashboard
          const showHead = shouldShowHeader(msg, i);
          return (
            <div key={msg.id} className={`message ${isUser ? 'bot' : ''}`}>
              {showHead && (
                <div className="msg-header">
                  <div className="msg-avatar" style={{ background: isUser ? '#C8C8D0' : agentColor }}>
                    <span className="mi mi-fill" style={{ fontSize: 20 }}>{isUser ? 'person' : 'smart_toy'}</span>
                  </div>
                  <span className="msg-sender">{msg.senderName}</span>
                  <span className="msg-time">{fmtTime(msg.timestamp)}</span>
                </div>
              )}
              <div className="msg-bubble-wrap">
                <button className="msg-copy-btn" onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(msg.content).then(() => {
                    setCopiedToast(true);
                    setTimeout(() => setCopiedToast(false), 1500);
                  }).catch(() => {});
                }} title="Copy message">
                  <span className="mi" style={{ fontSize: 16 }}>content_copy</span>
                </button>
                {(() => {
                  const media = parseMedia(msg.content, selectedGroup?.folder);
                  if (media.type === 'image') {
                    return (
                      <div className="message-bubble media-bubble">
                        <img src={media.thumbUrl} alt={media.filename} className="msg-media-img" loading="lazy" onClick={() => setViewingMedia({ url: media.url, filename: media.filename, type: 'image' })} />
                        {media.text && <div className="msg-media-caption" dangerouslySetInnerHTML={{ __html: renderMarkdown(media.text) }} />}
                        <span className="time">{fmtTime(msg.timestamp)}</span>
                      </div>
                    );
                  }
                  if (media.type === 'video') {
                    return (
                      <div className="message-bubble media-bubble">
                        <video src={media.url} className="msg-media-video" controls preload="metadata" />
                        {media.text && <div className="msg-media-caption" dangerouslySetInnerHTML={{ __html: renderMarkdown(media.text) }} />}
                        <span className="time">{fmtTime(msg.timestamp)}</span>
                      </div>
                    );
                  }
                  if (media.type === 'pdf') {
                    return (
                      <div className="message-bubble media-bubble" style={{ padding: 0 }}>
                        <a href={media.url} target="_blank" rel="noopener" className="msg-pdf-header" style={{ cursor: 'pointer', textDecoration: 'none', color: 'inherit' }}>
                          <span className="mi" style={{ fontSize: 22, color: 'var(--error)' }}>picture_as_pdf</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{media.filename}</div>
                            <div style={{ fontSize: 11, color: 'var(--text2)' }}>PDF Document &middot; Tap to open</div>
                          </div>
                          <span className="mi" style={{ fontSize: 20, color: 'var(--text3)' }}>open_in_new</span>
                        </a>
                        {media.text && <div className="msg-media-caption" dangerouslySetInnerHTML={{ __html: renderMarkdown(media.text) }} />}
                        <span className="time" style={{ padding: '0 12px 6px', display: 'block' }}>{fmtTime(msg.timestamp)}</span>
                      </div>
                    );
                  }
                  if (media.type === 'file') {
                    return (
                      <div className="message-bubble">
                        <a href={media.url} target="_blank" rel="noopener" className="msg-file-link">
                          <span className="mi" style={{ fontSize: 18 }}>description</span>
                          <span>{media.filename}</span>
                        </a>
                        {media.text && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(media.text) }} />}
                        <span className="time">{fmtTime(msg.timestamp)}</span>
                      </div>
                    );
                  }
                  return (
                    <div
                      className="message-bubble"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(msg.content) + (!showHead ? `<span class="time">${fmtTime(msg.timestamp)}</span>` : '')
                      }}
                    />
                  );
                })()}
              </div>
            </div>
          );
        })}
        {processing && (
          <div className="typing-indicator">
            <span className="typing-dots"><span>.</span><span>.</span><span>.</span></span>
            <span>{selectedGroup?.name} is thinking</span>
            <span className="processing-badge">Processing</span>
            {selectedJid && (
              <button className="stop-agent-btn" onClick={() => { api.interruptSession(selectedJid); }} title="Stop current turn">
                <span className="mi" style={{ fontSize: 16 }}>stop_circle</span>
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Copied toast */}
      {copiedToast && (
        <div style={{ position: 'absolute', bottom: 100, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: 'white', padding: '8px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, zIndex: 100, pointerEvents: 'none' }}>
          Copied to clipboard
        </div>
      )}

      {/* Scroll to bottom button */}
      {showScrollDown && (
        <button className="scroll-down-btn" onClick={scrollToBottom}>
          <span className="mi">keyboard_arrow_down</span>
        </button>
      )}

      {/* Command autocomplete */}
      {showCommands && filteredCommands.length > 0 && (
        <div className="cmd-menu" ref={cmdMenuRef}>
          {filteredCommands.map((cmd, i) => (
            <div key={cmd.command} className={`cmd-item ${i === selectedCmd ? 'selected' : ''}`} onClick={() => selectCommand(cmd)}>
              <span className="cmd-name">{cmd.prefix || '/'}{cmd.command}{cmd.args?.length ? ' ' + cmd.args.map(a => `<${a.name}>`).join(' ') : ''}</span>
              <span className="cmd-desc">{cmd.description}</span>
            </div>
          ))}
        </div>
      )}

      {/* Staged file preview */}
      {stagedFiles.length > 0 && (
        <div className="staged-files">
          {stagedFiles.map((f, i) => (
            <div className="staged-file" key={`${f.name}-${i}`}>
              {f.type.startsWith('image/') ? (
                <img src={URL.createObjectURL(f)} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} />
              ) : (
                <span className="mi" style={{ fontSize: 16 }}>attach_file</span>
              )}
              <span className="staged-file-name">{f.name}</span>
              <span className="staged-file-size">{f.size < 1024 ? `${f.size}B` : f.size < 1048576 ? `${(f.size/1024).toFixed(0)}KB` : `${(f.size/1048576).toFixed(1)}MB`}</span>
              <button className="staged-file-remove" onClick={() => setStagedFiles(prev => prev.filter((_, j) => j !== i))}>
                <span className="mi" style={{ fontSize: 16 }}>close</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Stateless mode indicator */}
      {stateless && (
        <div className="stateless-indicator">
          <span className="mi" style={{ fontSize: 15 }}>bolt</span>
          <span>Fresh session — no history</span>
          <button className="stateless-dismiss" onClick={() => setStateless(false)}>
            <span className="mi" style={{ fontSize: 14 }}>close</span>
          </button>
        </div>
      )}

      {/* Floating input */}
      <div className={`chat-input-bar${input.startsWith('!') ? ' command-mode' : ''}`}>
        <label className="attach-btn">
          <span className="mi">attach_file</span>
          <input type="file" style={{ display: 'none' }} onChange={upload} multiple />
        </label>
        <button
          type="button"
          className={`stateless-toggle${stateless ? ' active' : ''}`}
          onClick={() => setStateless(s => !s)}
          title={stateless ? 'Stateless mode on — tap to switch back' : 'Switch to stateless (fresh session)'}
        >
          <span className="mi" style={{ fontSize: 20 }}>bolt</span>
        </button>
        <div
          ref={inputRef as any}
          className="chat-editable"
          contentEditable={!sending}
          role="textbox"
          data-placeholder="Type a message..."
          onInput={e => {
            const text = (e.target as HTMLDivElement).innerText;
            onInputChange(text);
          }}
          onKeyDown={e => {
            onInputKeyDown(e);
          }}
          onPaste={e => {
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
          }}
          suppressContentEditableWarning
        />
        <button type="button" className={`send-btn ${(input.trim() || stagedFiles.length) ? 'ready' : 'idle'}`} onClick={send} disabled={sending || (!input.trim() && !stagedFiles.length)}>
          <span className="mi" style={{ fontSize: 20 }}>send</span>
        </button>
      </div>

      {/* Media viewer */}
      {viewingMedia && (
        <MediaViewer
          url={viewingMedia.url}
          filename={viewingMedia.filename}
          type={viewingMedia.type}
          onClose={() => setViewingMedia(null)}
        />
      )}
    </div>
  );
}
