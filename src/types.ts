export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamed?: boolean;
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    contextWindow?: number;
  };
  performance?: {
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    costUsd: number;
  };
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  isTransient?: boolean; // Agent closes after response instead of idling 30min. Fresh session each trigger.
  memoryMode?: 'full' | 'local' | 'none'; // full=mem0 scoped, local=CLAUDE.md only, none=no memory
  memoryScopes?: string[]; // which shared scope tags this group can access when memoryMode='full'
  memoryUserId?: string; // mem0 userId for this group's private memory pool (default: 'venky')
  showInSidebar?: boolean; // Whether to show in chat sidebar (default: true). False = only in Settings/Overview.
  idleTimeoutMinutes?: number; // 0 = always on, null/undefined = default (30min), N = custom minutes
  allowedSkills?: string[]; // Skill folders to load. Empty = all skills.
  mode?: string; // Kept for DB compat. Always 'tmux' now.
  workDir?: string; // Custom working directory (absolute path)
  model?: 'opus' | 'sonnet'; // Claude model to use (default: opus)
  contextWindow?: '200k' | '1m'; // Context window size (default: 200k)
  allowedMcpServers?: string[]; // MCP server names to load from ~/.claude.json. Empty = none (only nanoclaw). ['__all__'] = all.
  gmailFilter?: { subjectContains?: string[]; fromContains?: string[] }; // Route matching emails here instead of main group
}

/** Check if a group's memoryUserId (possibly comma-separated) includes this userId */
export function groupHasUser(
  memoryUserId: string | undefined,
  userId: string,
): boolean {
  const ids = (memoryUserId || 'venky').split(',').map((s) => s.trim());
  return ids.includes(userId);
}

/** Get all user IDs from a group's memoryUserId (possibly comma-separated) */
export function getGroupUserIds(memoryUserId: string | undefined): string[] {
  return (memoryUserId || 'venky')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Get the primary (first) user ID from a group's memoryUserId */
export function getPrimaryUserId(memoryUserId: string | undefined): string {
  return (memoryUserId || 'venky').split(',')[0].trim();
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Todos & Reminders ---

export interface Todo {
  id: string;
  user_id: string;
  title: string;
  data: string | null;
  status: 'pending' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  due_date: string | null;
  remind_at: string | null;
  recurrence: string | null;
  reminder_fired_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// --- Email Classification & Structured Extraction ---

/** Schema definition for an email type — loaded from groups/{folder}/email-schemas.json */
export interface EmailSchemaDefinition {
  type: string; // e.g. "FinancialTransaction", "SupportTicket"
  description: string; // short description for the LLM to understand when to classify as this type
  classificationPrompt: string; // detailed prompt telling the LLM how to identify this type
  fields: {
    mandatory: Record<string, string>; // field name → description/allowed values
    optional: Record<string, string>; // field name → description (use "NA" when not available)
  };
}

/** The classification + extraction result from the LLM */
export interface EmailClassification {
  emailType: string; // dynamic — matches a registered schema type, or "Other"
  summary: string; // 1-2 sentence plain English summary
  data: Record<string, unknown> | null; // typed extraction fields per the matched schema
}

// --- Email Rules ---

export interface EmailRule {
  id: string;
  name: string;
  priority: number;
  from_pattern: string;
  subject_pattern: string;
  body_pattern: string;
  email_type_pattern: string; // comma-separated EmailType values to match (empty = any)
  action: 'forward' | 'archive' | 'discard' | 'command';
  target_group: string; // group folder name (for 'forward'/'command' actions)
  command_name: string; // command to invoke (for 'command' action)
  extract_prompt: string; // optional Gemini extraction prompt (empty = default summarization)
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: send a file attachment. Channels that support it implement it.
  sendFile?(jid: string, filePath: string, caption?: string): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
