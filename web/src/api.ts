const BASE = '';

function getToken(): string {
  // Check URL hash for token (mc.neved.in/#token=xxx)
  const hash = window.location.hash;
  if (hash.startsWith('#token=')) {
    const token = hash.slice(7);
    localStorage.setItem('nanoclaw_token', token);
    window.location.hash = '';
    return token;
  }
  return localStorage.getItem('nanoclaw_token') || '';
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  if (!token) {
    const entered = prompt('Enter DevenClaw token:');
    if (entered) {
      localStorage.setItem('nanoclaw_token', entered);
      window.location.reload();
    }
    throw new Error('No token');
  }

  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(!opts.body || typeof opts.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('nanoclaw_token');
    const newToken = prompt('Token invalid. Enter Mission Control token:');
    if (newToken) {
      localStorage.setItem('nanoclaw_token', newToken);
      window.location.reload();
    }
    throw new Error('Unauthorized');
  }
  return res.json();
}

async function requestFormData<T>(path: string, formData: FormData): Promise<T> {
  const token = getToken();
  if (!token) throw new Error('No token');

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });
  if (res.status === 401) throw new Error('Unauthorized');
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `Upload failed (${res.status})`);
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse<T> = { ok: boolean; data: T; error?: string };

export interface EmailRule {
  id: string;
  name: string;
  priority: number;
  from_pattern: string;
  subject_pattern: string;
  body_pattern: string;
  action: 'forward' | 'archive' | 'discard' | 'command';
  target_group: string;
  command_name: string;
  extract_prompt: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface EmailLogEntry {
  id: string;
  message_id: string;
  thread_id: string;
  from_address: string;
  subject: string;
  rule_id: string | null;
  rule_name: string | null;
  action: string;
  target_group: string | null;
  summary: string | null;
  input_tokens: number;
  output_tokens: number;
  processed_at: string;
}

export const api = {
  getProcessing: () =>
    request<ApiResponse<{ activeGroupFolders: string[] }>>('/api/processing'),

  getStatus: () =>
    request<ApiResponse<{ uptime: number; assistantName: string; groupCount: number; taskCount: number; activeTasks: number; sessionCount: number }>>('/api/status'),

  getGroups: () =>
    request<ApiResponse<Array<{ jid: string; name: string; folder: string; channel: string; lastActivity: string; isMain: boolean; isTransient: boolean; requiresTrigger: boolean; hasSession: boolean; showInSidebar: boolean; model: string }>>>('/api/groups'),

  getMessages: (jid: string, limit = 50) =>
    request<ApiResponse<Array<{ id: string; sender: string; senderName: string; content: string; timestamp: string; isFromMe: boolean; isBotMessage: boolean }>>>(`/api/groups/${encodeURIComponent(jid)}/messages?limit=${limit}`),

  getDraft: (jid: string) =>
    request<ApiResponse<{ content: string }>>(`/api/groups/${encodeURIComponent(jid)}/draft`),

  setDraft: (jid: string, content: string) =>
    request<ApiResponse<null>>(`/api/groups/${encodeURIComponent(jid)}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),

  sendChat: (chatJid: string, text: string, stateless?: boolean) =>
    request<ApiResponse<null>>('/api/chat/send', {
      method: 'POST',
      body: JSON.stringify({ chatJid, text, stateless }),
    }),

  uploadFile: (folder: string, formData: FormData) =>
    requestFormData<ApiResponse<{ filename: string; size: number; path: string }>>(`/api/groups/${folder}/upload`, formData),

  getSessions: () =>
    request<ApiResponse<Array<{ folder: string; sessionId: string; groupName: string; jid: string }>>>('/api/sessions'),

  killSession: (jid: string) =>
    request<ApiResponse<null>>(`/api/sessions/${encodeURIComponent(jid)}/kill`, { method: 'POST' }),

  interruptSession: (jid: string) =>
    request<ApiResponse<null>>(`/api/sessions/${encodeURIComponent(jid)}/interrupt`, { method: 'POST' }),

  getTasks: () =>
    request<ApiResponse<Array<{ id: string; group_folder: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string | null; last_run: string | null; last_result: string | null }>>>('/api/tasks'),

  pauseTask: (id: string) =>
    request<ApiResponse<{ id: string; status: string }>>(`/api/tasks/${id}/pause`, { method: 'POST' }),

  resumeTask: (id: string) =>
    request<ApiResponse<{ id: string; status: string }>>(`/api/tasks/${id}/resume`, { method: 'POST' }),

  deleteTask: (id: string) =>
    request<ApiResponse<null>>(`/api/tasks/${id}`, { method: 'DELETE' }),

  getTaskLogs: (id: string) =>
    request<ApiResponse<Array<{ task_id: string; run_at: string; duration_ms: number; status: string; result: string | null; error: string | null }>>>(`/api/tasks/${id}/logs`),

  // Todos
  getTodos: () =>
    request<ApiResponse<Array<{ id: string; user_id: string; title: string; data: string | null; status: string; priority: string; due_date: string | null; created_by: string; created_at: string; updated_at: string }>>>('/api/todos'),

  createTodo: (todo: { title: string; data?: string; priority?: string; due_date?: string }) =>
    request<ApiResponse<any>>('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(todo) }),

  updateTodo: (id: string, updates: Record<string, any>) =>
    request<ApiResponse<any>>(`/api/todos/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) }),

  deleteTodo: (id: string) =>
    request<ApiResponse<null>>(`/api/todos/${id}`, { method: 'DELETE' }),

  getLogs: (folder: string) =>
    request<ApiResponse<Array<{ name: string; content: string }>>>(`/api/logs/${folder}`),

  getContextUsage: (jid: string) =>
    request<ApiResponse<{ percent: number; sizeKB: number }>>(`/api/groups/${encodeURIComponent(jid)}/context`),

  getGroupSettings: (jid: string) =>
    request<ApiResponse<{ jid: string; name: string; folder: string; isMain: boolean; isTransient: boolean; memoryMode: string; memoryScopes: string[]; memoryUserId: string; showInSidebar: boolean; idleTimeoutMinutes: number | null; allowedSkills: string[]; model: string; tokens: Array<{ name: string; role: string; isOwner: boolean }> }>>(`/api/groups/${encodeURIComponent(jid)}/settings`),

  updateGroupSettings: (jid: string, settings: { memoryMode?: string; memoryScopes?: string[]; memoryUserId?: string; isTransient?: boolean; showInSidebar?: boolean; idleTimeoutMinutes?: number | null; allowedSkills?: string[]; allowedMcpServers?: string[]; model?: string }) =>
    request<ApiResponse<any>>(`/api/groups/${encodeURIComponent(jid)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  updateTokenReminderGroup: (token: string, reminderGroupJid: string | null) =>
    request<ApiResponse<any>>(`/api/tokens/${encodeURIComponent(token)}/reminder-group`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reminderGroupJid }) }),

  getContainerStats: () =>
    request<ApiResponse<Array<{ name: string; cpu: string; mem: string; pids: number }>>>('/api/containers/stats'),

  getMemories: () =>
    request<ApiResponse<Array<{ id: string; memory: string; score?: number; metadata?: Record<string, any> }>>>('/api/mem0/memories'),

  updateMemoryScope: (id: string, scope: string | string[]) =>
    request<ApiResponse<null>>(`/api/mem0/memories/${encodeURIComponent(id)}/scope`, {
      method: 'POST',
      body: JSON.stringify({ scope }),
    }),

  deleteMemory: (id: string) =>
    request<ApiResponse<null>>(`/api/mem0/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getMem0Stats: () =>
    request<ApiResponse<{ totalRecords: number; dbSize: string; dbSizeBytes: number; actions: Record<string, number>; recent?: Array<{ id: string; value: string; action: string; createdAt: string }> }>>('/api/mem0/stats'),

  getMe: () =>
    request<ApiResponse<{ name: string; role: string; isOwner: boolean; canSend: boolean; allowedGroups: string[] }>>('/api/me'),

  getTokens: () =>
    request<ApiResponse<Array<{ token: string; tokenFull: string; name: string; role: string; allowedGroups: string[]; canSend: boolean; isOwner: boolean; createdAt: string }>>>('/api/tokens'),

  createToken: (name: string, role: string, allowedGroups: string[], canSend: boolean) =>
    request<ApiResponse<{ token: string; name: string }>>('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, role, allowedGroups, canSend }),
    }),

  deleteToken: (token: string) =>
    request<ApiResponse<{ deleted: boolean }>>(`/api/tokens/${encodeURIComponent(token)}`, { method: 'DELETE' }),

  getCommands: (folder?: string) =>
    request<ApiResponse<Array<{ command: string; description: string; prefix?: string }>>>(`/api/commands${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`),

  getSkills: () =>
    request<ApiResponse<Array<{ name: string; description: string; type: string; folder: string }>>>('/api/skills'),

  getMcpServers: () =>
    request<ApiResponse<Array<{ name: string; type: string }>>>('/api/mcp-servers'),

  // Email rules
  getEmailRules: () =>
    request<ApiResponse<EmailRule[]>>('/api/email-rules'),
  createEmailRule: (rule: Omit<EmailRule, 'id' | 'created_at' | 'updated_at'>) =>
    request<ApiResponse<EmailRule>>('/api/email-rules', { method: 'POST', body: JSON.stringify(rule), headers: { 'Content-Type': 'application/json' } }),
  updateEmailRule: (id: string, updates: Partial<EmailRule>) =>
    request<ApiResponse<null>>(`/api/email-rules/${id}`, { method: 'PUT', body: JSON.stringify(updates), headers: { 'Content-Type': 'application/json' } }),
  deleteEmailRule: (id: string) =>
    request<ApiResponse<null>>(`/api/email-rules/${id}`, { method: 'DELETE' }),
  getEmailLog: (limit = 50, offset = 0) =>
    request<ApiResponse<EmailLogEntry[]>>(`/api/email-log?limit=${limit}&offset=${offset}`),

  getTokenUsage: (opts?: { days?: number; folder?: string; since?: string; until?: string }) => {
    const params = new URLSearchParams();
    if (opts?.days) params.set('days', String(opts.days));
    if (opts?.folder) params.set('folder', opts.folder);
    if (opts?.since) params.set('since', opts.since);
    if (opts?.until) params.set('until', opts.until);
    const qs = params.toString();
    return request<ApiResponse<Array<{ group_folder: string; total_input: number; total_cache_creation: number; total_cache_read: number; total_output: number; total_tokens: number; turn_count: number; stateful_tokens: number; stateless_tokens: number; stateful_turns: number; stateless_turns: number }>>>(`/api/token-usage${qs ? `?${qs}` : ''}`);
  },

  getAlerts: () =>
    request<ApiResponse<Array<{ id: number; group_folder: string; group_name: string; type: string; message: string; duration_ms: number | null; num_turns: number | null; cost_usd: number | null; context_percent: number | null; created_at: string; dismissed: boolean }>>>('/api/alerts'),

  dismissAlert: (id: number) =>
    request<ApiResponse<null>>(`/api/alerts/${id}/dismiss`, { method: 'POST' }),

  getAnalytics: () =>
    request<ApiResponse<{ groups: Array<{ jid: string; name: string; folder: string; channel: string; totalMessages: number; userMessages: number; botMessages: number; hasSession: boolean; lastActivity: string; transcriptSize: number; currentTranscriptSize: number; contextPercent: number; attachmentSize: number }>; totalGroups: number; totalTasks: number; activeTasks: number; totalSessions: number }>>('/api/analytics'),

  getClaudeUsage: () =>
    request<ApiResponse<{ session: { percent: number; resetIn: string | null }; weeklyAll: { percent: number; resets: string | null }; weeklySonnet: { percent: number; resets: string | null }; scrapedAt: string } | null>>('/api/claude-usage'),

  // Memory scope definitions
  getScopes: () =>
    request<ApiResponse<Array<{ name: string; description: string; created_at: string }>>>('/api/mem0/scopes'),

  createScope: (name: string, description: string) =>
    request<ApiResponse<{ name: string; description: string }>>('/api/mem0/scopes', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),

  deleteScope: (name: string) =>
    request<ApiResponse<null>>(`/api/mem0/scopes/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Move memory to shared pool
  moveToShared: (id: string, scope: string, sourceUserId?: string) =>
    request<ApiResponse<null>>(`/api/mem0/memories/${encodeURIComponent(id)}/move-to-shared`, {
      method: 'POST',
      body: JSON.stringify({ scope, sourceUserId }),
    }),

  // Suggest scope for a memory text
  suggestScope: (text: string) =>
    request<ApiResponse<{ scope: string | null }>>('/api/mem0/suggest-scope', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  getExtractionStats: () =>
    request<ApiResponse<{ today: { calls: number; input_tokens: number; output_tokens: number }; week: { calls: number; input_tokens: number; output_tokens: number }; total: { calls: number; input_tokens: number; output_tokens: number }; byType: Record<string, number> }>>('/api/extraction-stats'),
};
