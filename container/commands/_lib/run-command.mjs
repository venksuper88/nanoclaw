/**
 * run-command.mjs — Call another command from within a command.
 *
 * Usage:
 *   import { runCmd } from '../_lib/run-command.mjs';
 *   const result = await runCmd('ask', { model: '2.5-flash', prompt: 'Hello' });
 *   // result = { message: '...', data: { ... } }
 *
 * Resolution: group-local commands first, then global — same as the orchestrator.
 * Inherits NANOCLAW_GROUP_FOLDER and NANOCLAW_CHAT_JID from the parent process.
 */

import { execFileSync, execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || '';
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const GLOBAL_COMMANDS_DIR = path.join(PROJECT_ROOT, 'container', 'commands');

const RUNTIMES = {
  node: 'node',
  bash: 'bash',
  python: 'python3',
};

function resolveCommand(name) {
  // Local: groups/{folder}/commands/{name}/
  const localDir = path.join(GROUPS_DIR, GROUP_FOLDER, 'commands', name);
  const localDef = loadDef(localDir);
  if (localDef) return { dir: localDir, def: localDef };

  // Global: container/commands/{name}/
  const globalDir = path.join(GLOBAL_COMMANDS_DIR, name);
  const globalDef = loadDef(globalDir);
  if (globalDef) return { dir: globalDir, def: globalDef };

  return null;
}

function loadDef(dir) {
  const p = path.join(dir, 'COMMAND.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function inferBin(entry) {
  if (entry.endsWith('.mjs') || entry.endsWith('.js')) return 'node';
  if (entry.endsWith('.sh')) return 'bash';
  if (entry.endsWith('.py')) return 'python3';
  return 'node';
}

/**
 * Run a command by name with JSON input. Returns parsed stdout.
 * @param {string} name - Command name (e.g. 'ask', 'process-txn')
 * @param {object} input - JSON input to pass via stdin
 * @param {object} [opts] - Options
 * @param {number} [opts.timeout] - Timeout in ms (default: 60000)
 * @returns {Promise<{ message?: string, data?: object }>}
 */
export async function runCmd(name, input = {}, opts = {}) {
  const resolved = resolveCommand(name);
  if (!resolved) {
    throw new Error(`Command not found: ${name}`);
  }

  const { dir, def } = resolved;
  const entry = def.entry || 'run.mjs';
  const entryPath = path.join(dir, entry);
  const bin = RUNTIMES[def.runtime] || inferBin(entry);
  const timeout = opts.timeout || (def.timeout ? def.timeout * 1000 : 60_000);

  return new Promise((resolve, reject) => {
    const child = execFile(bin, [entryPath], {
      cwd: dir,
      env: {
        ...process.env,
        NANOCLAW_COMMAND_NAME: name,
      },
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Command "${name}" failed: ${stderr || err.message}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch {
        resolve({ message: stdout.trim() });
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

/**
 * Run a command synchronously. Simpler but blocks the event loop.
 * @param {string} name - Command name
 * @param {object} input - JSON input
 * @returns {{ message?: string, data?: object }}
 */
export function runCmdSync(name, input = {}) {
  const resolved = resolveCommand(name);
  if (!resolved) {
    throw new Error(`Command not found: ${name}`);
  }

  const { dir, def } = resolved;
  const entry = def.entry || 'run.mjs';
  const entryPath = path.join(dir, entry);
  const bin = RUNTIMES[def.runtime] || inferBin(entry);
  const timeout = def.timeout ? def.timeout * 1000 : 60_000;

  const stdout = execFileSync(bin, [entryPath], {
    cwd: dir,
    input: JSON.stringify(input),
    env: {
      ...process.env,
      NANOCLAW_COMMAND_NAME: name,
    },
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });

  try {
    return JSON.parse(stdout.toString());
  } catch {
    return { message: stdout.toString().trim() };
  }
}
