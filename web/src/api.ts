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
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse<T> = { ok: boolean; data: T; error?: string };

export const api = {
  getProcessing: () =>
    request<ApiResponse<{ activeGroupFolders: string[] }>>('/api/processing'),

  getStatus: () =>
    request<ApiResponse<{ uptime: number; assistantName: string; groupCount: number; taskCount: number; activeTasks: number; sessionCount: number }>>('/api/status'),

  getGroups: () =>
    request<ApiResponse<Array<{ jid: string; name: string; folder: string; channel: string; lastActivity: string; isMain: boolean; isTransient: boolean; requiresTrigger: boolean; hasSession: boolean; showInSidebar: boolean }>>>('/api/groups'),

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

  sendChat: (chatJid: string, text: string) =>
    request<ApiResponse<null>>('/api/chat/send', {
      method: 'POST',
      body: JSON.stringify({ chatJid, text }),
    }),

  uploadFile: (folder: string, formData: FormData) =>
    requestFormData<ApiResponse<{ filename: string; size: number; path: string }>>(`/api/groups/${folder}/upload`, formData),

  getSessions: () =>
    request<ApiResponse<Array<{ folder: string; sessionId: string; groupName: string; jid: string }>>>('/api/sessions'),

  killSession: (jid: string) =>
    request<ApiResponse<null>>(`/api/sessions/${encodeURIComponent(jid)}/kill`, { method: 'POST' }),

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

  // Reminders
  getReminders: () =>
    request<ApiResponse<Array<{ id: string; user_id: string; title: string; data: string | null; remind_at: string; recurrence: string | null; status: string; snoozed_until: string | null; created_by: string; created_at: string }>>>('/api/reminders'),

  createReminder: (reminder: { title: string; data?: string; remind_at: string; recurrence?: string }) =>
    request<ApiResponse<any>>('/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reminder) }),

  updateReminder: (id: string, updates: Record<string, any>) =>
    request<ApiResponse<any>>(`/api/reminders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) }),

  snoozeReminder: (id: string, snooze_until: string) =>
    request<ApiResponse<any>>(`/api/reminders/${id}/snooze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snooze_until }) }),

  dismissReminder: (id: string) =>
    request<ApiResponse<any>>(`/api/reminders/${id}/dismiss`, { method: 'POST' }),

  deleteReminder: (id: string) =>
    request<ApiResponse<null>>(`/api/reminders/${id}`, { method: 'DELETE' }),

  getLogs: (folder: string) =>
    request<ApiResponse<Array<{ name: string; content: string }>>>(`/api/logs/${folder}`),

  getContextUsage: (jid: string) =>
    request<ApiResponse<{ percent: number; sizeKB: number }>>(`/api/groups/${encodeURIComponent(jid)}/context`),

  getGroupSettings: (jid: string) =>
    request<ApiResponse<{ jid: string; name: string; folder: string; isMain: boolean; isTransient: boolean; memoryMode: string; memoryScopes: string[]; memoryUserId: string; showInSidebar: boolean; idleTimeoutMinutes: number | null; allowedSkills: string[]; tokens: Array<{ name: string; role: string; isOwner: boolean }> }>>(`/api/groups/${encodeURIComponent(jid)}/settings`),

  updateGroupSettings: (jid: string, settings: { memoryMode?: string; memoryScopes?: string[]; memoryUserId?: string; isTransient?: boolean; showInSidebar?: boolean; idleTimeoutMinutes?: number | null; allowedSkills?: string[] }) =>
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

  getCommands: () =>
    request<ApiResponse<Array<{ command: string; description: string }>>>('/api/commands'),

  getSkills: () =>
    request<ApiResponse<Array<{ name: string; description: string; type: string; folder: string }>>>('/api/skills'),

  getAnalytics: () =>
    request<ApiResponse<{ groups: Array<{ jid: string; name: string; folder: string; channel: string; totalMessages: number; userMessages: number; botMessages: number; hasSession: boolean; lastActivity: string }>; totalGroups: number; totalTasks: number; activeTasks: number; totalSessions: number }>>('/api/analytics'),

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
};
