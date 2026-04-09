/**
 * Commands — scripts with a standard interface, no LLM needed.
 *
 * Resolution: groups/{folder}/commands/{name}/ (local) > container/commands/{name}/ (global)
 * Interface: COMMAND.json defines metadata, run.mjs (or run.sh/run.py) is the entry point.
 * Execution: child_process.spawn with JSON stdin/stdout, env vars for group context.
 * Lifecycle: sends start/complete/error messages to the owning group's chat.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const PROJECT_ROOT = process.cwd();
const GLOBAL_COMMANDS_DIR = path.resolve(PROJECT_ROOT, 'container', 'commands');

export interface CommandArg {
  name: string;
  description?: string;
  required?: boolean; // default: true
}

export interface CommandDefinition {
  name: string;
  description: string;
  runtime?: 'node' | 'bash' | 'python'; // default: inferred from entry
  entry?: string; // default: run.mjs
  args?: CommandArg[];
  timeout?: number; // seconds, default: 60
}

export interface CommandResult {
  status: 'success' | 'error';
  message?: string;
  data?: Record<string, unknown>;
  exitCode: number;
}

/** Resolve a command by name: local group folder first, then global. */
export function resolveCommand(
  commandName: string,
  groupFolder: string,
): { dir: string; def: CommandDefinition } | null {
  // Local: groups/{folder}/commands/{name}/
  const localDir = path.join(GROUPS_DIR, groupFolder, 'commands', commandName);
  const localDef = loadCommandDef(localDir);
  if (localDef) return { dir: localDir, def: localDef };

  // Global: container/commands/{name}/
  const globalDir = path.join(GLOBAL_COMMANDS_DIR, commandName);
  const globalDef = loadCommandDef(globalDir);
  if (globalDef) return { dir: globalDir, def: globalDef };

  return null;
}

/** List all commands available to a group (local + global, local takes precedence). */
export function listCommands(groupFolder: string): CommandDefinition[] {
  const seen = new Set<string>();
  const commands: CommandDefinition[] = [];

  // Local commands first
  const localDir = path.join(GROUPS_DIR, groupFolder, 'commands');
  if (fs.existsSync(localDir)) {
    for (const name of fs.readdirSync(localDir)) {
      const def = loadCommandDef(path.join(localDir, name));
      if (def) {
        seen.add(def.name);
        commands.push(def);
      }
    }
  }

  // Global commands (skip if local override exists)
  if (fs.existsSync(GLOBAL_COMMANDS_DIR)) {
    for (const name of fs.readdirSync(GLOBAL_COMMANDS_DIR)) {
      const def = loadCommandDef(path.join(GLOBAL_COMMANDS_DIR, name));
      if (def && !seen.has(def.name)) {
        commands.push(def);
      }
    }
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function loadCommandDef(dir: string): CommandDefinition | null {
  const defPath = path.join(dir, 'COMMAND.json');
  if (!fs.existsSync(defPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(defPath, 'utf-8'));
    return {
      name: raw.name || path.basename(dir),
      description: raw.description || '',
      runtime: raw.runtime,
      entry: raw.entry,
      args: Array.isArray(raw.args) ? raw.args : undefined,
      timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
    };
  } catch {
    return null;
  }
}

/** Map positional CLI args to named inputs using the command's arg definitions.
 *  The last defined arg is greedy — it consumes all remaining tokens up to
 *  any trailing tokens that look like filenames (contain a dot after position).
 *  Extra positional args beyond defined ones go into `_rest` as an array. */
export function mapArgsToInput(
  argDefs: CommandArg[] | undefined,
  positionalArgs: string[],
  sender?: string,
): Record<string, unknown> {
  if (!argDefs || argDefs.length === 0) {
    return { args: positionalArgs.join(' '), sender };
  }
  const input: Record<string, unknown> = {};
  // Always include raw args string for commands that want to parse themselves
  input._raw = positionalArgs.join(' ');

  for (let i = 0; i < argDefs.length; i++) {
    if (i === argDefs.length - 1) {
      // Last defined arg is greedy — gets all remaining positional args
      input[argDefs[i].name] = positionalArgs.slice(i).join(' ') || null;
    } else {
      input[argDefs[i].name] = positionalArgs[i] ?? null;
    }
  }
  if (sender) input.sender = sender;
  return input;
}

function inferRuntime(entry: string): { bin: string; args: string[] } {
  if (entry.endsWith('.mjs') || entry.endsWith('.js')) {
    return { bin: 'node', args: [entry] };
  }
  if (entry.endsWith('.sh')) {
    return { bin: 'bash', args: [entry] };
  }
  if (entry.endsWith('.py')) {
    return { bin: 'python3', args: [entry] };
  }
  // Default to node
  return { bin: 'node', args: [entry] };
}

export interface RunCommandOpts {
  commandName: string;
  groupFolder: string;
  chatJid: string;
  input: Record<string, unknown>;
  /** Callback to send lifecycle messages to the group's chat */
  sendMessage: (text: string) => Promise<void>;
  /** Timeout in ms (default: 60s) */
  timeoutMs?: number;
}

/** Execute a command in an isolated child process. */
export async function runCommand(opts: RunCommandOpts): Promise<CommandResult> {
  const {
    commandName,
    groupFolder,
    chatJid,
    input,
    sendMessage,
    timeoutMs: overrideTimeoutMs,
  } = opts;

  const resolved = resolveCommand(commandName, groupFolder);
  if (!resolved) {
    const msg = `Command not found: ${commandName}`;
    logger.warn({ commandName, groupFolder }, msg);
    return { status: 'error', message: msg, exitCode: 1 };
  }

  const { dir, def } = resolved;
  const entry = def.entry || 'run.mjs';
  const entryPath = path.join(dir, entry);
  // Priority: caller override > COMMAND.json timeout (seconds→ms) > 60s default
  const timeoutMs = overrideTimeoutMs ?? (def.timeout ? def.timeout * 1000 : 60_000);

  if (!fs.existsSync(entryPath)) {
    const msg = `Command entry not found: ${entryPath}`;
    logger.warn({ commandName, entryPath }, msg);
    return { status: 'error', message: msg, exitCode: 1 };
  }

  // Resolve runtime
  let bin: string;
  let args: string[];
  if (def.runtime === 'node') {
    bin = 'node';
    args = [entryPath];
  } else if (def.runtime === 'bash') {
    bin = 'bash';
    args = [entryPath];
  } else if (def.runtime === 'python') {
    bin = 'python3';
    args = [entryPath];
  } else {
    const inferred = inferRuntime(entry);
    bin = inferred.bin;
    args = [entryPath];
  }

  // Send start message
  await sendMessage(`Running command: ${commandName}`).catch(() => {});

  logger.info(
    { commandName, groupFolder, entry: entryPath },
    'Executing command',
  );

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd: dir,
      env: {
        ...process.env,
        NANOCLAW_GROUP_FOLDER: groupFolder,
        NANOCLAW_CHAT_JID: chatJid,
        NANOCLAW_COMMAND_NAME: commandName,
        NANOCLAW_PROJECT_ROOT: PROJECT_ROOT,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // Write input as JSON to stdin
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    // Timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const msg = `Command timed out after ${timeoutMs / 1000}s: ${commandName}`;
      logger.warn({ commandName, groupFolder }, msg);
      sendMessage(`Command failed: ${commandName} — timed out`).catch(() => {});
      resolve({ status: 'error', message: msg, exitCode: 124 });
    }, timeoutMs);

    child.on('close', async (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;

      if (exitCode !== 0) {
        const errMsg = stderr.trim() || `Exit code ${exitCode}`;
        logger.error(
          { commandName, groupFolder, exitCode, stderr: errMsg },
          'Command failed',
        );
        await sendMessage(
          `Command failed: ${commandName} — ${errMsg.slice(0, 200)}`,
        ).catch(() => {});
        resolve({ status: 'error', message: errMsg, exitCode });
        return;
      }

      // Parse stdout as JSON, fallback to raw text
      let data: Record<string, unknown> | undefined;
      let message = stdout.trim();
      try {
        const parsed = JSON.parse(stdout);
        if (typeof parsed === 'object' && parsed !== null) {
          data = parsed;
          message = parsed.message || parsed.text || message;
        }
      } catch {
        // stdout is plain text, use as-is
      }

      logger.info({ commandName, groupFolder, exitCode }, 'Command completed');
      await sendMessage(message || `Command completed: ${commandName}`).catch(
        () => {},
      );
      resolve({ status: 'success', message, data, exitCode: 0 });
    });

    child.on('error', async (err) => {
      clearTimeout(timer);
      const msg = `Command spawn error: ${err.message}`;
      logger.error({ commandName, groupFolder, err }, msg);
      await sendMessage(
        `Command failed: ${commandName} — ${err.message}`,
      ).catch(() => {});
      resolve({ status: 'error', message: msg, exitCode: 1 });
    });
  });
}
