/**
 * Tmux Runner for NanoClaw
 *
 * Manages persistent tmux sessions that run `claude-lts -p` per turn.
 * The tmux session stays alive between turns (survives NanoClaw restarts).
 * Each turn spawns a `claude-lts -p` invocation that exits when done.
 *
 * Message flow:
 *   1. Host writes enriched prompt to a temp file
 *   2. Host sends wrapper script via tmux send-keys
 *   3. Claude processes (reads, edits, builds — all local)
 *   4. Claude responds via MCP send_message (picked up by IPC watcher)
 *   5. Wrapper writes done-marker when claude exits
 *   6. Host detects done-marker, turn is complete
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const TMUX_BIN = process.env.TMUX_BIN || '/opt/homebrew/bin/tmux';
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/local/bin/claude-lts';
const TMUX_PREFIX = 'nanoclaw';
const DONE_POLL_MS = 500;
const DONE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max per turn

export interface TmuxInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  assistantName?: string;
}

export interface TmuxOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface TmuxStreamEvent {
  type: 'text' | 'send_message';
  content: string;
  sender?: string;
}

function tmuxSessionName(folder: string): string {
  return `${TMUX_PREFIX}-${folder}`;
}

function tmuxExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch {
    return '';
  }
}

/** Check if a tmux session exists */
export function sessionExists(folder: string): boolean {
  const name = tmuxSessionName(folder);
  const result = tmuxExec(
    `${TMUX_BIN} has-session -t ${name} 2>/dev/null && echo yes`,
  );
  return result === 'yes';
}

/** List all nanoclaw tmux sessions */
export function listSessions(): string[] {
  const output = tmuxExec(
    `${TMUX_BIN} list-sessions -F "#{session_name}" 2>/dev/null`,
  );
  if (!output) return [];
  return output.split('\n').filter((s) => s.startsWith(TMUX_PREFIX + '-'));
}

function groupWorkDir(folder: string): string {
  return path.resolve(GROUPS_DIR, folder);
}

function groupClaudeDir(folder: string): string {
  return path.join(DATA_DIR, 'sessions', folder, '.claude');
}

function groupIpcDir(folder: string): string {
  return resolveGroupIpcPath(folder);
}

function mcpServerPath(): string {
  return path.resolve(
    process.cwd(),
    'container',
    'agent-runner',
    'dist',
    'ipc-mcp-stdio.js',
  );
}

function wrapperScriptPath(folder: string): string {
  return path.join(DATA_DIR, 'sessions', folder, 'run-claude.sh');
}

/**
 * Set up Claude settings, skills, MCP config, and auth for a tmux group.
 */
function setupClaudeConfig(group: RegisteredGroup, chatJid: string): void {
  const claudeDir = groupClaudeDir(group.folder);
  const settingsFile = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });

  const ipcDir = groupIpcDir(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  const settings = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath()],
        env: {
          NANOCLAW_CHAT_JID: chatJid,
          NANOCLAW_GROUP_FOLDER: group.folder,
          NANOCLAW_IS_MAIN: group.isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: ipcDir,
        },
      },
    },
  };

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

  // Copy user's .claude.json (auth, theme, preferences) to skip first-run setup.
  // CLAUDE_CONFIG_DIR changes where .claude/ lives, but .claude.json must be
  // at the same level as .claude/ (its parent directory).
  const homeClaudeJson = path.join(os.homedir(), '.claude.json');
  const groupClaudeJson = path.join(claudeDir, '..', '.claude.json');
  if (fs.existsSync(homeClaudeJson)) {
    fs.copyFileSync(homeClaudeJson, groupClaudeJson);
  }

  // Sync skills
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsDst)) {
    fs.rmSync(skillsDst, { recursive: true, force: true });
  }
  if (fs.existsSync(skillsSrc)) {
    const allowedSkills = group.allowedSkills;
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      if (
        allowedSkills &&
        allowedSkills.length > 0 &&
        !allowedSkills.includes(skillDir)
      )
        continue;
      fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
    }
  }

  // Copy settings + skills into the group's working directory .claude/
  // so claude picks them up as project-level config (no CLAUDE_CONFIG_DIR needed)
  const projectClaudeDir = path.join(groupWorkDir(group.folder), '.claude');
  fs.mkdirSync(projectClaudeDir, { recursive: true });
  fs.copyFileSync(settingsFile, path.join(projectClaudeDir, 'settings.json'));
  if (fs.existsSync(skillsDst)) {
    const projectSkills = path.join(projectClaudeDir, 'skills');
    if (fs.existsSync(projectSkills)) {
      fs.rmSync(projectSkills, { recursive: true, force: true });
    }
    fs.cpSync(skillsDst, projectSkills, { recursive: true });
  }

  // Create wrapper script for non-interactive `-p` mode
  // Auth + global MCPs come from ~/.claude.json
  // Per-group MCP scoping via env vars (nanoclaw MCP reads from process.env)
  const wrapper = `#!/bin/bash
# Run claude-lts in print mode and write done marker on completion
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export NANOCLAW_CHAT_JID="${chatJid}"
export NANOCLAW_GROUP_FOLDER="${group.folder}"
export NANOCLAW_IS_MAIN="${group.isMain ? '1' : '0'}"
export NANOCLAW_IPC_DIR="${ipcDir}"
CLAUDE_BIN="${CLAUDE_BIN}"
PROMPT_FILE="$1"
SESSION_ARG="$2"
DONE_FILE="$3"

RESUME_FLAG=""
if [ -n "$SESSION_ARG" ] && [ "$SESSION_ARG" != "new" ]; then
  RESUME_FLAG="--resume $SESSION_ARG"
fi

PROMPT=$(cat "$PROMPT_FILE")
rm -f "$PROMPT_FILE"

STREAM_LOG="\${DONE_FILE%.json}.stream"
"$CLAUDE_BIN" -p "$PROMPT" $RESUME_FLAG --output-format stream-json --verbose --dangerously-skip-permissions 2>"$DONE_FILE.stderr" | tee "$STREAM_LOG"

EXIT_CODE=\${PIPESTATUS[0]}
echo "{\\"type\\":\\"done\\",\\"exit_code\\":$EXIT_CODE}" > "$DONE_FILE"
`;
  const scriptPath = wrapperScriptPath(group.folder);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, wrapper, { mode: 0o755 });
}

/**
 * Create a tmux session for a group if it doesn't exist.
 * The session is just a shell — claude-lts runs per-turn via the wrapper script.
 */
export function ensureSession(group: RegisteredGroup, chatJid: string): void {
  const name = tmuxSessionName(group.folder);
  const workDir = groupWorkDir(group.folder);

  fs.mkdirSync(workDir, { recursive: true });
  setupClaudeConfig(group, chatJid);

  if (sessionExists(group.folder)) {
    logger.debug({ session: name }, 'Tmux session already exists');
    return;
  }

  const cmd = `${TMUX_BIN} new-session -d -s ${name} -c "${workDir}" -x 200 -y 50`;
  try {
    execSync(cmd, { timeout: 5000 });
    logger.info({ session: name, workDir }, 'Tmux session created');
  } catch (err) {
    logger.error({ session: name, err }, 'Failed to create tmux session');
    throw err;
  }
}

/**
 * Parse a stream-json line and extract forwarding events.
 * Returns events for assistant text blocks, SendMessage tool calls, and result events.
 * Uses emittedKeys set for deduplication across progressive snapshots.
 */
function parseStreamLine(
  line: string,
  emittedKeys: Set<string>,
): TmuxStreamEvent[] {
  const events: TmuxStreamEvent[] = [];
  try {
    const event = JSON.parse(line);

    // Handle assistant events (progressive snapshots during generation)
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          const key = `text:${block.text}`;
          if (!emittedKeys.has(key)) {
            emittedKeys.add(key);
            events.push({ type: 'text', content: block.text });
          }
        }
        if (
          block.type === 'tool_use' &&
          block.name === 'SendMessage' &&
          block.input
        ) {
          const msg =
            block.input.message ||
            block.input.content ||
            block.input.summary ||
            '';
          if (msg) {
            const key = `send:${msg}`;
            if (!emittedKeys.has(key)) {
              emittedKeys.add(key);
              events.push({
                type: 'send_message',
                content: msg,
                sender: block.input.sender,
              });
            }
          }
        }
      }
    }

    // Handle result event (final catch-all with the complete response)
    if (event.type === 'result' && event.result) {
      const key = `text:${event.result}`;
      if (!emittedKeys.has(key)) {
        emittedKeys.add(key);
        events.push({ type: 'text', content: event.result });
      }
    }
  } catch {
    // Not valid JSON — skip
  }
  return events;
}

/**
 * Send a prompt to the tmux session and wait for completion.
 */
export async function runTmuxAgent(
  group: RegisteredGroup,
  input: TmuxInput,
  onStreamEvent?: (event: TmuxStreamEvent) => void,
): Promise<TmuxOutput> {
  const name = tmuxSessionName(group.folder);

  // Write prompt to temp file
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ipcDir = groupIpcDir(group.folder);
  const promptFile = path.join(ipcDir, 'input', `prompt-${nonce}.txt`);
  const doneFile = path.join(ipcDir, 'input', `done-${nonce}.json`);
  const scriptPath = wrapperScriptPath(group.folder);

  fs.writeFileSync(promptFile, input.prompt);

  // Don't resume sessions in tmux -p mode — each turn is standalone.
  // Context continuity comes from CLAUDE.md and mem0 enrichment.
  const sessionArg = 'new';

  // Send wrapper command to tmux
  const tmuxCmd = `${TMUX_BIN} send-keys -t ${name} 'bash "${scriptPath}" "${promptFile}" "${sessionArg}" "${doneFile}"' Enter`;
  try {
    execSync(tmuxCmd, { timeout: 5000 });
    logger.info(
      { session: name, nonce, hasSession: !!input.sessionId },
      'Prompt sent to tmux session',
    );
  } catch (err) {
    logger.error({ session: name, err }, 'Failed to send prompt to tmux');
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* ignore */
    }
    return {
      status: 'error',
      result: null,
      error: `Failed to send to tmux: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Stream log file: the wrapper tees stdout here
  const streamLogFile = doneFile.replace(/\.json$/, '.stream');
  let streamOffset = 0; // Track how far we've read
  let streamBuffer = ''; // Partial line buffer
  const emittedKeys = new Set<string>(); // Dedup across progressive snapshots

  function drainStreamLog(): void {
    if (!onStreamEvent || !fs.existsSync(streamLogFile)) return;
    try {
      const fd = fs.openSync(streamLogFile, 'r');
      const stat = fs.fstatSync(fd);
      if (stat.size <= streamOffset) {
        fs.closeSync(fd);
        return;
      }
      const buf = Buffer.alloc(stat.size - streamOffset);
      fs.readSync(fd, buf, 0, buf.length, streamOffset);
      fs.closeSync(fd);
      streamOffset = stat.size;

      const chunk = streamBuffer + buf.toString('utf-8');
      const lines = chunk.split('\n');
      // Last element may be incomplete — buffer it
      streamBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const events = parseStreamLine(trimmed, emittedKeys);
        for (const evt of events) {
          onStreamEvent(evt);
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Error reading stream log');
    }
  }

  // Poll for done marker
  const startTime = Date.now();
  while (Date.now() - startTime < DONE_TIMEOUT_MS) {
    // Drain stream events before checking done marker
    drainStreamLog();

    if (fs.existsSync(doneFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(doneFile, 'utf-8'));
        fs.unlinkSync(doneFile);
        // Final drain to catch any remaining stream events
        drainStreamLog();
        // Clean up stderr log and stream log on success
        try {
          fs.unlinkSync(`${doneFile}.stderr`);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(streamLogFile);
        } catch {
          /* ignore */
        }

        // Extract session ID and result text from tmux pane output
        let newSessionId: string | undefined;
        let resultText: string | null = null;
        // Capture with join-wrapped lines (-J) for clean JSON parsing
        const paneOutput = tmuxExec(
          `${TMUX_BIN} capture-pane -t ${name} -p -J -S -200 2>/dev/null`,
        );

        // Parse the last result event from stream-json output
        const resultLines = paneOutput
          .split('\n')
          .filter((l) => l.includes('"type":"result"'));
        logger.debug(
          { resultLineCount: resultLines.length },
          'Parsed result lines from pane',
        );
        if (resultLines.length > 0) {
          try {
            const resultEvent = JSON.parse(resultLines[resultLines.length - 1]);
            newSessionId = resultEvent.session_id;
            resultText = resultEvent.result || null;
          } catch {
            // Fall back to regex
            const sessionMatch = paneOutput.match(/"session_id":"([^"]+)"/);
            if (sessionMatch) newSessionId = sessionMatch[1];
          }
        } else {
          const sessionMatch = paneOutput.match(/"session_id":"([^"]+)"/);
          if (sessionMatch) newSessionId = sessionMatch[1];
        }

        // Only store session ID if the turn was truly successful (not auth error)
        const isRealSuccess =
          data.exit_code === 0 &&
          resultText &&
          !resultText.includes('Not logged in');
        const output: TmuxOutput = {
          status: data.exit_code === 0 ? 'success' : 'error',
          result: resultText,
          newSessionId: isRealSuccess ? newSessionId : undefined,
          error:
            data.exit_code !== 0
              ? `claude exited with code ${data.exit_code}`
              : undefined,
        };

        logger.info(
          {
            session: name,
            duration: Date.now() - startTime,
            exitCode: data.exit_code,
            newSessionId,
            hasResult: !!resultText,
            resultPreview: resultText?.slice(0, 100),
          },
          'Tmux turn completed',
        );

        return output;
      } catch (err) {
        logger.warn({ err, doneFile }, 'Failed to parse done marker');
        try {
          fs.unlinkSync(doneFile);
        } catch {
          /* ignore */
        }
        return {
          status: 'error',
          result: null,
          error: 'Failed to parse done marker',
        };
      }
    }
    await new Promise((r) => setTimeout(r, DONE_POLL_MS));
  }

  logger.error({ session: name, nonce }, 'Tmux turn timed out');
  return {
    status: 'error',
    result: null,
    error: 'Tmux turn timed out after 30 minutes',
  };
}

/**
 * Recover existing tmux sessions on startup.
 */
export function recoverSessions(): string[] {
  const sessions = listSessions();
  const recovered: string[] = [];
  for (const session of sessions) {
    const folder = session.slice(TMUX_PREFIX.length + 1);
    if (folder) {
      recovered.push(folder);
      logger.info({ session, folder }, 'Recovered existing tmux session');
    }
  }
  return recovered;
}

/**
 * Kill a tmux session.
 */
export function killSession(folder: string): void {
  const name = tmuxSessionName(folder);
  tmuxExec(`${TMUX_BIN} kill-session -t ${name} 2>/dev/null`);
  logger.info({ session: name }, 'Tmux session killed');
}
