import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'OLLAMA_BASE_URL',
  'MEMORY_ENABLED',
  'MEMORY_LLM_MODEL',
  'MEMORY_EMBED_MODEL',
  'DASHBOARD_PORT',
  'DASHBOARD_TOKEN',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_EMAIL',
  'GEMINI_API_KEY',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep agent alive after last result
export const TRANSIENT_CLOSE_DELAY_MS = parseInt(
  process.env.TRANSIENT_CLOSE_DELAY_MS || '30000',
  10,
); // 30s default — how long to keep transient agent alive after last activity
export const MAX_CONCURRENT_AGENTS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AGENTS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Memory service (mem0 + Ollama)
export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ||
  envConfig.OLLAMA_BASE_URL ||
  'http://localhost:11434';
export const MEMORY_ENABLED =
  (process.env.MEMORY_ENABLED || envConfig.MEMORY_ENABLED || 'true') === 'true';
export const MEMORY_LLM_MODEL =
  process.env.MEMORY_LLM_MODEL || envConfig.MEMORY_LLM_MODEL || 'llama3.2';
export const MEMORY_EMBED_MODEL =
  process.env.MEMORY_EMBED_MODEL ||
  envConfig.MEMORY_EMBED_MODEL ||
  'nomic-embed-text';

// Dashboard
export const DASHBOARD_PORT = parseInt(
  process.env.DASHBOARD_PORT || envConfig.DASHBOARD_PORT || '3002',
  10,
);
export const DASHBOARD_TOKEN =
  process.env.DASHBOARD_TOKEN || envConfig.DASHBOARD_TOKEN || '';

// Turso (cloud SQLite)
export const TURSO_DATABASE_URL =
  process.env.TURSO_DATABASE_URL || envConfig.TURSO_DATABASE_URL || '';
export const TURSO_AUTH_TOKEN =
  process.env.TURSO_AUTH_TOKEN || envConfig.TURSO_AUTH_TOKEN || '';

// Web Push (VAPID)
export const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || envConfig.VAPID_PUBLIC_KEY || '';
export const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || envConfig.VAPID_PRIVATE_KEY || '';
export const VAPID_EMAIL =
  process.env.VAPID_EMAIL || envConfig.VAPID_EMAIL || '';

// Gemini (content extraction)
export const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || envConfig.GEMINI_API_KEY || '';
