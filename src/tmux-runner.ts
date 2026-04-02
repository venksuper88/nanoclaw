/**
 * Tmux Runner for DevenClaw
 *
 * Manages persistent tmux sessions that run `claude-lts -p` per turn.
 * The tmux session stays alive between turns (survives DevenClaw restarts).
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
const DONE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min max per turn
const TRANSCRIPT_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB — auto-fresh if exceeded
const TRANSCRIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  sessionResumed?: boolean;
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

export interface TmuxStreamEvent {
  type: 'text' | 'send_message' | 'activity';
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

function groupWorkDir(folder: string, workDir?: string): string {
  if (workDir) return path.resolve(workDir);
  return path.resolve(GROUPS_DIR, folder);
}

function groupClaudeDir(folder: string): string {
  return path.join(DATA_DIR, 'sessions', folder, '.claude');
}

function groupIpcDir(folder: string): string {
  return resolveGroupIpcPath(folder);
}

/**
 * Claude Code stores session transcripts in ~/.claude/projects/-{cwd-with-dashes}/.
 * Returns the transcript directory for a group's working directory.
 */
export function transcriptDir(folder: string, workDir?: string): string {
  const cwd = groupWorkDir(folder, workDir);
  const slug = cwd.replace(/[/_]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

/**
 * Check if the active session's transcript exceeds the size limit.
 * Returns true if the session should be skipped (start fresh).
 */
function isTranscriptOversized(folder: string, sessionId: string, workDir?: string): boolean {
  const dir = transcriptDir(folder, workDir);
  const file = path.join(dir, `${sessionId}.jsonl`);
  try {
    const stat = fs.statSync(file);
    if (stat.size > TRANSCRIPT_SIZE_LIMIT) {
      logger.warn(
        { folder, sessionId, sizeMB: (stat.size / 1024 / 1024).toFixed(1) },
        'Transcript exceeds 5MB limit, starting fresh session',
      );
      return true;
    }
  } catch {
    // File doesn't exist — fine, not oversized
  }
  return false;
}

/**
 * Delete transcript files older than 7 days from the group's Claude projects dir.
 */
function cleanOldTranscripts(folder: string, workDir?: string): void {
  const dir = transcriptDir(folder, workDir);
  if (!fs.existsSync(dir)) return;

  const cutoff = Date.now() - TRANSCRIPT_MAX_AGE_MS;
  let cleaned = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // skip individual file errors
      }
    }
    if (cleaned > 0) {
      logger.info({ folder, cleaned }, 'Cleaned old transcript files');
    }
  } catch (err) {
    logger.warn({ folder, err }, 'Failed to clean old transcripts');
  }
}

/**
 * Get the size of the current session's transcript file (in bytes).
 */
export function getSessionTranscriptSize(folder: string, sessionId: string, workDir?: string): number {
  const dir = transcriptDir(folder, workDir);
  const file = path.join(dir, `${sessionId}.jsonl`);
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Get total size of all .jsonl transcript files for a group (in bytes).
 */
export function getTranscriptSize(folder: string, workDir?: string): number {
  const dir = transcriptDir(folder, workDir);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.jsonl')) continue;
      try {
        total += fs.statSync(path.join(dir, entry)).size;
      } catch {
        // skip individual file errors
      }
    }
  } catch {
    // directory read error
  }
  return total;
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

  // Status line script writes Claude Code's pre-calculated context JSON to IPC
  const contextFile = path.join(ipcDir, 'context.json');
  const settings = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
    statusLine: `bash -c 'cat > "${contextFile}"'`,
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
    } as Record<string, any>,
  };

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

  // Merge allowed global MCP servers from ~/.claude.json into settings.json.
  // Without this, agents only get the nanoclaw MCP server. Per-group
  // allowedMcpServers controls which global MCPs (metabase, etc.) to include.
  const homeClaudeJson = path.join(os.homedir(), '.claude.json');
  const groupClaudeJson = path.join(claudeDir, '..', '.claude.json');
  let homeClaudeParsed: any = null;
  if (fs.existsSync(homeClaudeJson)) {
    try {
      homeClaudeParsed = JSON.parse(fs.readFileSync(homeClaudeJson, 'utf-8'));
      const globalMcps = homeClaudeParsed.mcpServers || {};
      const allowed = group.allowedMcpServers || [];
      const isAllMode = allowed.includes('__all__');
      for (const [name, config] of Object.entries(globalMcps)) {
        if (name === 'nanoclaw') continue; // already defined per-group
        if (isAllMode || allowed.includes(name)) {
          settings.mcpServers[name] = config as any;
        }
      }
      // Re-write settings.json with any merged MCP servers
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    } catch {
      // JSON parse failed — settings.json already written above
    }
  }

  // Copy user's .claude.json (auth, theme, preferences) to skip first-run setup.
  // IMPORTANT: Strip mcpServers from the copy — MCP servers are controlled
  // exclusively via settings.json. Without this, every agent inherits all
  // MCP servers from ~/.claude.json (e.g. Metabase 68 tools), bloating the
  // system prompt to 130K+ tokens and costing $0.49 per cold cache.
  if (homeClaudeParsed) {
    const stripped = { ...homeClaudeParsed };
    delete stripped.mcpServers;
    fs.writeFileSync(groupClaudeJson, JSON.stringify(stripped));
  } else if (fs.existsSync(homeClaudeJson)) {
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
  // Also sync global user skills from ~/.claude/skills/ (e.g. create-skill)
  // Container skills take precedence — global skills won't overwrite them
  const globalSkillsSrc = path.join(os.homedir(), '.claude', 'skills');
  if (fs.existsSync(globalSkillsSrc)) {
    for (const skillDir of fs.readdirSync(globalSkillsSrc)) {
      const srcDir = path.join(globalSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      if (fs.existsSync(dstDir)) continue; // container skill takes precedence
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Copy settings + skills into the group's working directory .claude/
  // so claude picks them up as project-level config (no CLAUDE_CONFIG_DIR needed)
  const projectClaudeDir = path.join(groupWorkDir(group.folder, group.workDir), '.claude');
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
  // Clean up old transcript files (> 7 days) on each session setup
  cleanOldTranscripts(group.folder, group.workDir);

  const wrapper = `#!/bin/bash
# Run claude-lts in print mode and write done marker on completion
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export NANOCLAW_CHAT_JID="${chatJid}"
export NANOCLAW_GROUP_FOLDER="${group.folder}"
export NANOCLAW_IS_MAIN="${group.isMain ? '1' : '0'}"
export NANOCLAW_IPC_DIR="${ipcDir}"
MODEL="${group.contextWindow === '1m'
  ? (group.model === 'sonnet' ? 'claude-sonnet-4-6[1m]' : 'claude-opus-4-6[1m]')
  : (group.model === 'sonnet' ? 'sonnet' : 'opus')}"
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
"$CLAUDE_BIN" -p "$PROMPT" $RESUME_FLAG --model "$MODEL" --output-format stream-json --verbose --dangerously-skip-permissions 2>"$DONE_FILE.stderr" | tee "$STREAM_LOG"

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
  const workDir = groupWorkDir(group.folder, group.workDir);

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
        if (block.type === 'tool_use' && block.name && block.id) {
          if (block.name === 'SendMessage' && block.input) {
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
          // Emit activity for ALL tool calls (visibility into what agent is doing)
          const actKey = `tool:${block.id}`;
          if (!emittedKeys.has(actKey)) {
            emittedKeys.add(actKey);
            let summary = `\u2192 ${block.name}`;
            if (block.input) {
              if (block.name === 'Read' && block.input.file_path) {
                summary += ` ${block.input.file_path}`;
              } else if (block.name === 'Edit' && block.input.file_path) {
                summary += ` ${block.input.file_path}`;
              } else if (block.name === 'Write' && block.input.file_path) {
                summary += ` ${block.input.file_path}`;
              } else if (block.name === 'Bash' && block.input.command) {
                summary += ` $ ${block.input.command.slice(0, 80)}`;
              } else if (block.name === 'Glob' && block.input.pattern) {
                summary += ` ${block.input.pattern}`;
              } else if (block.name === 'Grep' && block.input.pattern) {
                summary += ` /${block.input.pattern}/`;
              } else if (block.name === 'Agent' && block.input.description) {
                summary += ` ${block.input.description}`;
              } else if (block.name === 'Skill' && block.input.skill) {
                summary += ` /${block.input.skill}`;
              }
            }
            events.push({ type: 'activity', content: summary });
          }
        }
      }
    }

    // Handle tool_result events — show errors in activity stream
    if (event.type === 'tool_result' && event.is_error && event.content) {
      const errText =
        typeof event.content === 'string'
          ? event.content
          : JSON.stringify(event.content);
      const key = `err:${errText.slice(0, 200)}`;
      if (!emittedKeys.has(key)) {
        emittedKeys.add(key);
        events.push({
          type: 'activity',
          content: `\u2717 Error: ${errText.slice(0, 200)}`,
        });
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

  // Check transcript size — skip resume if > 5MB to avoid corruption/slowness
  let sessionArg = input.sessionId || 'new';
  const willResume = sessionArg !== 'new';
  if (willResume && isTranscriptOversized(input.groupFolder, sessionArg, group.workDir)) {
    sessionArg = 'new';
  }

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
  let lastAssistantUsage: TmuxOutput['usage'] | undefined; // Track latest API call's usage
  let resultContextWindow: number | undefined; // Context window from result event
  let resultPerformance: TmuxOutput['performance'] | undefined; // Performance from result event

  function drainStreamLog(): void {
    if (!onStreamEvent || !fs.existsSync(streamLogFile)) return;
    try {
      const fd = fs.openSync(streamLogFile, 'r');
      const stat = fs.fstatSync(fd);
      if (stat.size <= streamOffset) {
        fs.closeSync(fd);
        return;
      }
      const newBytes = stat.size - streamOffset;
      const buf = Buffer.alloc(newBytes);
      fs.readSync(fd, buf, 0, buf.length, streamOffset);
      fs.closeSync(fd);
      streamOffset = stat.size;

      const chunk = streamBuffer + buf.toString('utf-8');
      const lines = chunk.split('\n');
      // Last element may be incomplete — buffer it
      streamBuffer = lines.pop() || '';

      logger.info(
        { newBytes, lineCount: lines.length, streamLogFile },
        'drainStreamLog: read new data',
      );

      let emittedCount = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Extract usage from each assistant event (last one = current context window)
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'assistant' && parsed.message?.usage) {
            const u = parsed.message.usage;
            lastAssistantUsage = {
              input_tokens: u.input_tokens ?? 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
            };
          }
          // Extract contextWindow from result event's modelUsage
          if (parsed.type === 'result' && parsed.modelUsage) {
            const models = Object.values(parsed.modelUsage) as Array<{ contextWindow?: number }>;
            if (models.length > 0 && models[0].contextWindow) {
              resultContextWindow = models[0].contextWindow;
            }
          }
        } catch { /* not JSON, skip */ }
        const events = parseStreamLine(trimmed, emittedKeys);
        for (const evt of events) {
          emittedCount++;
          logger.info(
            { type: evt.type, contentPreview: evt.content?.slice(0, 80) },
            'drainStreamLog: emitting stream event',
          );
          onStreamEvent(evt);
        }
      }
      if (emittedCount > 0) {
        logger.info({ emittedCount }, 'drainStreamLog: emitted events');
      }
    } catch (err) {
      logger.error(
        { err, streamLogFile, streamOffset },
        'Error reading stream log',
      );
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

        // Extract session ID and result text from the stream log (complete record).
        // Previously used tmux capture-pane (-S -200) which lost data for long conversations.
        let newSessionId: string | undefined;
        let resultText: string | null = null;

        if (fs.existsSync(streamLogFile)) {
          try {
            const streamContent = fs.readFileSync(streamLogFile, 'utf-8');
            const resultLines = streamContent
              .split('\n')
              .filter((l) => l.includes('"type":"result"'));
            logger.debug(
              { resultLineCount: resultLines.length },
              'Parsed result lines from stream log',
            );
            if (resultLines.length > 0) {
              try {
                const resultEvent = JSON.parse(
                  resultLines[resultLines.length - 1],
                );
                newSessionId = resultEvent.session_id;
                resultText = resultEvent.result || null;
                if (resultEvent.duration_ms != null) {
                  resultPerformance = {
                    durationMs: resultEvent.duration_ms,
                    durationApiMs: resultEvent.duration_api_ms ?? 0,
                    numTurns: resultEvent.num_turns ?? 1,
                    costUsd: resultEvent.total_cost_usd ?? 0,
                  };
                }
              } catch {
                const sessionMatch = streamContent.match(
                  /"session_id":"([^"]+)"/,
                );
                if (sessionMatch) newSessionId = sessionMatch[1];
              }
            } else {
              const sessionMatch = streamContent.match(
                /"session_id":"([^"]+)"/,
              );
              if (sessionMatch) newSessionId = sessionMatch[1];
            }
          } catch (err) {
            logger.warn({ err, streamLogFile }, 'Failed to read stream log');
          }
        }

        // Fallback: try tmux pane capture if stream log didn't yield session ID
        if (!newSessionId) {
          const paneOutput = tmuxExec(
            `${TMUX_BIN} capture-pane -t ${name} -p -J -S -200 2>/dev/null`,
          );
          const resultLines = paneOutput
            .split('\n')
            .filter((l) => l.includes('"type":"result"'));
          if (resultLines.length > 0) {
            try {
              const resultEvent = JSON.parse(
                resultLines[resultLines.length - 1],
              );
              if (!newSessionId) newSessionId = resultEvent.session_id;
              if (!resultText) resultText = resultEvent.result || null;
              if (!resultPerformance && resultEvent.duration_ms != null) {
                resultPerformance = {
                  durationMs: resultEvent.duration_ms,
                  durationApiMs: resultEvent.duration_api_ms ?? 0,
                  numTurns: resultEvent.num_turns ?? 1,
                  costUsd: resultEvent.total_cost_usd ?? 0,
                };
              }
            } catch {
              const sessionMatch = paneOutput.match(/"session_id":"([^"]+)"/);
              if (sessionMatch && !newSessionId) newSessionId = sessionMatch[1];
            }
          } else {
            const sessionMatch = paneOutput.match(/"session_id":"([^"]+)"/);
            if (sessionMatch) newSessionId = sessionMatch[1];
          }
        }

        // Clean up stderr log and stream log
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

        // Only store session ID if the turn was truly successful (not auth error)
        const isRealSuccess =
          data.exit_code === 0 &&
          resultText &&
          !resultText.includes('Not logged in');
        const output: TmuxOutput = {
          status: data.exit_code === 0 ? 'success' : 'error',
          result: resultText,
          newSessionId: isRealSuccess ? newSessionId : undefined,
          sessionResumed: willResume,
          error:
            data.exit_code !== 0
              ? `claude exited with code ${data.exit_code}`
              : undefined,
          usage: lastAssistantUsage
            ? { ...lastAssistantUsage, contextWindow: resultContextWindow }
            : undefined,
          performance: resultPerformance,
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

  // Kill the tmux session on timeout — the retry will create a fresh one
  logger.error({ session: name, nonce }, 'Tmux turn timed out, killing session');
  killSession(input.groupFolder);

  // Clean up temp files
  try { fs.unlinkSync(doneFile); } catch { /* ignore */ }
  try { fs.unlinkSync(`${doneFile}.stderr`); } catch { /* ignore */ }
  try { fs.unlinkSync(doneFile.replace(/\.json$/, '.stream')); } catch { /* ignore */ }

  return {
    status: 'error',
    result: null,
    error: 'Tmux turn timed out after 15 minutes',
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
