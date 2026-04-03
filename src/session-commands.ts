import type { NewMessage } from './types.js';
import { logger } from './logger.js';

/**
 * Recognized session commands that are intercepted by the orchestrator.
 * /compact, /context — forwarded to claude-lts (built-in slash commands)
 * /new — kills the current session and starts fresh (next message creates new session)
 */
const SESSION_COMMANDS = ['/compact', '/context', '/new'] as const;
export type SessionCommand = (typeof SESSION_COMMANDS)[number];

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): SessionCommand | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  for (const cmd of SESSION_COMMANDS) {
    if (text === cmd) return cmd;
  }
  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

/** Minimal agent result interface. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
  streamed?: boolean;
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  canSenderInteract: (msg: NewMessage) => boolean;
  clearSession: () => Promise<void>;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (!isSessionCommandAllowed(isMainGroup, !!cmdMsg.is_from_me)) {
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  logger.info({ group: groupName, command }, 'Session command');

  // --- /new: kill session locally, next message starts fresh ---
  if (command === '/new') {
    await deps.clearSession();
    await deps.sendMessage('Session cleared. Starting fresh.');
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // Other commands are forwarded to claude-lts which handles them
  // via processPromptSlashCommand() even in -p mode.
  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt
  await deps.setTyping(true);

  let hadCmdError = false;
  await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
