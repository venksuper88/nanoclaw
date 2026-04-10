import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DASHBOARD_PORT,
  DASHBOARD_TOKEN,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRANSIENT_CLOSE_DELAY_MS,
  TRIGGER_PATTERN,
} from './config.js';
import { dashboardEvents, contextCache } from './dashboard/events.js';
import {
  setChatSendFn,
  setActiveGroupsFn,
  setMemoryService,
  setSessionInterruptFn,
  setSessionKillFn,
} from './dashboard/routes.js';
import { startDashboard } from './dashboard/server.js';
import { initDashboardTokens } from './dashboard/auth.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  writeCommandsSnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  writeTodosSnapshot,
} from './ipc-snapshots.js';
import {
  ensureSession as ensureTmuxSession,
  interruptSession,
  killSession as killTmuxSession,
  recoverSessions as recoverTmuxSessions,
  runTmuxAgent,
  TmuxStreamEvent,
} from './tmux-runner.js';
import { handleSessionCommand } from './session-commands.js';
import { listCommands, runCommand } from './commands.js';
import {
  getAllChats,
  getAllMessagesSince,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTodosByUser,
  initDatabase,
  recordTokenUsage,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  insertAlert,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  preCompressAttachments,
  compressAllAttachments,
  extractAttachments,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { MemoryService } from './memory.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  AgentOutput,
  Channel,
  NewMessage,
  RegisteredGroup,
  getPrimaryUserId,
} from './types.js';
import { logger } from './logger.js';
import { initPushService, sendPushNotification } from './push.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let dbErrorCount = 0;

const channels: Channel[] = [];
const queue = new GroupQueue();
const memoryService = new MemoryService();

/** Per-group flag: next processGroupMessages run should use stateless mode */
const statelessPending: Record<string, boolean> = {};

async function loadState(): Promise<void> {
  lastTimestamp = (await getRouterState('last_timestamp')) || '';
  const agentTs = await getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = await getAllSessions();
  registeredGroups = await getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

async function saveState(): Promise<void> {
  await setRouterState('last_timestamp', lastTimestamp);
  await setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

async function registerGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  await setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export async function getAvailableGroups(): Promise<
  import('./ipc-snapshots.js').AvailableGroup[]
> {
  const chats = await getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  // Dashboard groups (dash:*) don't need a channel — they communicate via socket.io
  if (!channel && !chatJid.startsWith('dash:') && channels.length > 0) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = await getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Intercept session commands (/context, /compact, /new) BEFORE trigger check
  // so owner can always run session commands regardless of requiresTrigger setting
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: async (text) => {
        if (channel) await channel.sendMessage(chatJid, text);
        else {
          dashboardEvents.emitEvent('message:new', {
            chatJid,
            sender: group.name,
            senderName: group.name,
            content: text,
            timestamp: new Date().toISOString(),
            isFromMe: true,
          });
          await storeMessage({
            id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            chat_jid: chatJid,
            sender: group.name,
            sender_name: group.name,
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
          }).catch((err) =>
            logger.warn({ err }, 'storeMessage (session cmd) failed'),
          );
        }
      },
      setTyping: async (typing) => {
        await channel?.setTyping?.(chatJid, typing);
      },
      runAgent: async (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, false, onOutput),
      advanceCursor: (timestamp) => {
        lastAgentTimestamp[chatJid] = timestamp;
        saveState().catch(() => {});
      },
      formatMessages: (msgs, tz) => formatMessages(msgs, tz, group.folder),
      canSenderInteract: () => true,
      clearSession: async () => {
        delete sessions[group.folder];
        await setSession(group.folder, '').catch(() => {});
        killTmuxSession(group.folder);
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;

  // Intercept ! commands (scripts) before they reach the agent.
  // Skip is_from_me messages — the dashboard route already handled those.
  const lastMsg = missedMessages[missedMessages.length - 1];
  if (
    lastMsg &&
    !lastMsg.is_from_me &&
    lastMsg.content.trim().startsWith('!')
  ) {
    const text = lastMsg.content.trim();
    const parts = text.slice(1).trim().split(/\s+/);
    const commandName = parts[0];
    if (commandName) {
      const {
        runCommand: execCommand,
        resolveCommand: resolveCmd,
        mapArgsToInput,
      } = await import('./commands.js');
      const resolved = resolveCmd(commandName, group.folder);
      if (resolved) {
        const sendMsg = async (msg: string) => {
          const agentName = group.name || ASSISTANT_NAME;
          const msgId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const timestamp = new Date().toISOString();
          storeMessage({
            id: msgId,
            chat_jid: chatJid,
            sender: agentName,
            sender_name: agentName,
            content: msg,
            timestamp,
            is_from_me: false,
            is_bot_message: true,
          }).catch(() => {});
          dashboardEvents.emitEvent('message:new', {
            chatJid,
            sender: agentName,
            senderName: agentName,
            content: msg,
            timestamp,
            isFromMe: false,
          });
        };
        // Advance cursor so the command message isn't re-processed
        lastAgentTimestamp[chatJid] = lastMsg.timestamp;
        saveState().catch(() => {});
        execCommand({
          commandName,
          groupFolder: group.folder,
          chatJid,
          input: mapArgsToInput(resolved.def.args, parts.slice(1)),
          sendMessage: sendMsg,
        }).catch((err) =>
          logger.warn({ err, commandName }, 'Orchestrator ! command failed'),
        );
        return true;
      }
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Compress all images in attachments dir (in-place) before agent runs
  await compressAllAttachments(group.folder);
  await preCompressAttachments(missedMessages, group.folder);
  await extractAttachments(missedMessages, group.folder);
  const rawPrompt = formatMessages(missedMessages, TIMEZONE, group.folder);

  // Determine stateless mode: explicit toggle from dashboard, or email-forwarded messages
  // Gmail forwards emails with sender = email address (contains @)
  const isEmailMessage = missedMessages.some(
    (m) => !m.is_from_me && m.sender.includes('@'),
  );
  const isStateless = statelessPending[chatJid] === true || isEmailMessage;
  if (statelessPending[chatJid]) delete statelessPending[chatJid];

  // Memory: start session tracking and enrich with relevant memories
  // Skip memory enrichment for stateless turns — no context needed
  let prompt: string;
  if (isStateless) {
    prompt = rawPrompt;
    logger.info(
      { group: group.name },
      'Stateless turn — skipping memory enrichment',
    );
  } else {
    memoryService.startSession(group.folder);
    prompt = await memoryService.enrichMessage(
      chatJid,
      group.folder,
      rawPrompt,
      group.memoryMode || 'full',
      group.memoryScopes,
      group.memoryUserId,
    );
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  await saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (group.isTransient) {
      // Transient: short close delay, resettable by piped messages
      queue.setTransientTimer(chatJid, TRANSIENT_CLOSE_DELAY_MS);
    } else if (group.isMain || group.idleTimeoutMinutes === 0) {
      // Always-on: never auto-close — container stays alive until service restart
      if (idleTimer) clearTimeout(idleTimer);
    } else {
      if (idleTimer) clearTimeout(idleTimer);
      // Use per-group idle timeout if set, otherwise global default
      const timeoutMs = group.idleTimeoutMinutes
        ? group.idleTimeoutMinutes * 60 * 1000
        : IDLE_TIMEOUT;
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        queue.closeStdin(chatJid);
      }, timeoutMs);
    }
  };

  await channel?.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const sessionMode = isStateless
    ? ('stateless' as const)
    : ('stateful' as const);
  const output = await runAgent(
    group,
    prompt,
    chatJid,
    isStateless,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          memoryService.accumulateOutput(group.folder, text);
          // Skip agent:output emission if streaming already delivered this to the dashboard
          if (!result.streamed) {
            dashboardEvents.emitEvent('agent:output', {
              groupName: group.name,
              groupFolder: group.folder,
              text,
            });
          }
          // Store agent response in DB — skip if streamed (already stored per-chunk)
          if (!result.streamed) {
            const agentMsgId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            await storeMessage({
              id: agentMsgId,
              chat_jid: chatJid,
              sender: group.name,
              sender_name: group.name,
              content: text,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              is_bot_message: true,
            }).catch((err) => logger.warn({ err }, 'storeMessage failed'));
          }
          await channel?.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Emit context usage from Claude Code's statusLine output (context.json)
        try {
          const contextFile = path.join(
            resolveGroupIpcPath(group.folder),
            'context.json',
          );
          if (fs.existsSync(contextFile)) {
            const ctx = JSON.parse(fs.readFileSync(contextFile, 'utf-8'));
            const cw = ctx.context_window || {};
            const percent = cw.used_percentage ?? 0;
            if (percent > 0) {
              const tokens =
                (cw.current_usage?.input_tokens ?? 0) +
                (cw.current_usage?.cache_creation_input_tokens ?? 0) +
                (cw.current_usage?.cache_read_input_tokens ?? 0);
              dashboardEvents.emitEvent('context:update', {
                groupFolder: group.folder,
                percent,
                sizeKB: Math.round((tokens * 4) / 1024),
              });
            }
          }
        } catch {
          /* ignore */
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      // Emit context usage — always, even without result text
      if (result.usage) {
        const totalTokens =
          (result.usage.input_tokens ?? 0) +
          (result.usage.cache_creation_input_tokens ?? 0) +
          (result.usage.cache_read_input_tokens ?? 0);
        const contextWindowSize = result.usage.contextWindow || 200_000; // From result event, fallback 200K
        const percent = Math.round((totalTokens / contextWindowSize) * 100);
        if (percent > 0) {
          const sizeKB = Math.round((totalTokens * 4) / 1024);
          dashboardEvents.emitEvent('context:update', {
            groupFolder: group.folder,
            percent,
            sizeKB,
          });
          contextCache[group.folder] = { percent, sizeKB, tokens: totalTokens };
          // Persist to DB so it survives restarts
          setRouterState(
            `context_pct:${group.folder}`,
            JSON.stringify({ percent, sizeKB, tokens: totalTokens }),
          ).catch(() => {});
        }
        // Record token usage for analytics (tagged with session mode + actual cost)
        const costUsd = result.performance?.costUsd ?? 0;
        recordTokenUsage(
          group.folder,
          result.usage,
          sessionMode,
          costUsd,
        ).catch(() => {});
      }

      // Performance alerts — check thresholds and emit alerts
      if (result.performance) {
        const perf = result.performance;
        const alerts: Array<{ type: string; message: string }> = [];

        if (perf.durationMs > 180_000) {
          // > 3 min wall time
          const mins = (perf.durationMs / 60_000).toFixed(1);
          alerts.push({
            type: 'slow_response',
            message: `${group.name} took ${mins}min (${perf.numTurns} turns, $${perf.costUsd.toFixed(2)})`,
          });
        }
        if (perf.numTurns > 10) {
          alerts.push({
            type: 'high_turns',
            message: `${group.name} used ${perf.numTurns} turns — likely over-orchestrating`,
          });
        }
        if (perf.costUsd > 0.5) {
          // > $0.50 per invocation
          alerts.push({
            type: 'high_cost',
            message: `${group.name} cost $${perf.costUsd.toFixed(2)} in a single invocation`,
          });
        }

        // Context % alert
        const contextPct = contextCache[group.folder]?.percent ?? 0;
        if (contextPct > 80) {
          alerts.push({
            type: 'high_context',
            message: `${group.name} at ${contextPct}% context — consider /compact or /new`,
          });
        }

        for (const alert of alerts) {
          const timestamp = new Date().toISOString();
          insertAlert({
            group_folder: group.folder,
            group_name: group.name,
            type: alert.type,
            message: alert.message,
            duration_ms: perf.durationMs,
            num_turns: perf.numTurns,
            cost_usd: perf.costUsd,
            context_percent: contextPct,
            created_at: timestamp,
          }).catch(() => {});
          dashboardEvents.emitEvent('agent:alert', {
            groupName: group.name,
            groupFolder: group.folder,
            type: alert.type as any,
            message: alert.message,
            timestamp,
          });
        }
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
        dashboardEvents.emitEvent('agent:idle', {
          groupName: group.name,
          groupFolder: group.folder,
        });
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel?.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      memoryService.endSession(group.folder);
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    await saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    memoryService.endSession(group.folder);
    return false;
  }

  // Memory: extract facts from conversation and store for future retrieval
  await memoryService.writeBack(group.folder, rawPrompt, group.memoryUserId);
  memoryService.endSession(group.folder);

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  stateless: boolean = false,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // Stateless mode: force fresh session (no --resume), don't use stored session ID
  const sessionId = stateless
    ? undefined
    : group.isTransient
      ? undefined
      : sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = await getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Write todos and reminders snapshots (scoped by user)
  const userId = getPrimaryUserId(group.memoryUserId);
  const todos = await getTodosByUser(userId, true);
  writeTodosSnapshot(
    group.folder,
    todos.map((t) => ({
      id: t.id,
      user_id: t.user_id,
      title: t.title,
      data: t.data,
      status: t.status,
      priority: t.priority,
      due_date: t.due_date,
      created_at: t.created_at,
    })),
  );
  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = await getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Write commands snapshot for agent to read via list_commands MCP tool
  writeCommandsSnapshot(group.folder, listCommands(group.folder));

  const agentStart = Date.now();

  // Stuck agent detection: emit warning if no completion within 5 minutes
  const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
  const stuckTimer = setTimeout(() => {
    dashboardEvents.emitEvent('agent:stuck', {
      groupName: group.name,
      groupFolder: group.folder,
      elapsedMs: Date.now() - agentStart,
    });
    logger.warn(
      { group: group.name, elapsedMs: Date.now() - agentStart },
      'Agent appears stuck (5min with no completion)',
    );
  }, STUCK_THRESHOLD_MS);

  // All groups use tmux mode
  try {
    ensureTmuxSession(group, chatJid);

    // Emit agent:spawn so dashboard shows activity indicator
    dashboardEvents.emitEvent('agent:spawn', {
      groupName: group.name,
      groupFolder: group.folder,
      containerName: 'tmux',
    });

    // Forward real-time stream events (text + SendMessage + activity) to the dashboard
    const agentName = group.name || ASSISTANT_NAME;
    const handleStreamEvent = (evt: TmuxStreamEvent) => {
      logger.info(
        { evtType: evt.type, contentLen: evt.content?.length, chatJid },
        'handleStreamEvent called',
      );
      const content = evt.content;
      if (!content) return;

      // Activity events → container:log (shows in terminal panel)
      if (evt.type === 'activity') {
        dashboardEvents.emitEvent('container:log', {
          groupName: group.name,
          groupFolder: group.folder,
          line: content,
          stream: 'stdout',
        });
        return;
      }

      // Text + SendMessage events → message:new (shows in chat) + store to DB
      const sender = evt.sender || agentName;
      const msgId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const timestamp = new Date().toISOString();
      dashboardEvents.emitEvent('message:new', {
        chatJid,
        sender,
        senderName: sender,
        content,
        timestamp,
        isFromMe: true,
        isBotMessage: true,
        isStreamed: true,
      });
      // Persist streamed messages to DB so they survive page refresh.
      // onOutput will skip DB storage when streamed=true to avoid duplicates.
      storeMessage({
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: sender,
        content,
        timestamp,
        is_from_me: true,
        is_bot_message: true,
      }).catch((err) => logger.warn({ err }, 'storeMessage (stream) failed'));
    };

    const output = await runTmuxAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      handleStreamEvent,
    );

    clearTimeout(stuckTimer);

    // Emit agent:exit so dashboard hides activity indicator
    dashboardEvents.emitEvent('agent:exit', {
      groupName: group.name,
      groupFolder: group.folder,
      duration: Date.now() - agentStart,
    });

    // Clear stale session if resume failed — prevents infinite retry loop
    if (output.sessionInvalid) {
      logger.warn(
        { folder: group.folder },
        'Clearing invalid session ID — will start fresh on next message',
      );
      delete sessions[group.folder];
      setSession(group.folder, '').catch(() => {});
    }

    // Track session for resume — skip for stateless turns to preserve the main session
    if (output.newSessionId && !group.isTransient && !stateless) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId).catch((err) =>
        logger.warn({ err }, 'setSession failed'),
      );
    }

    // Deliver result via onOutput for DB storage, channel delivery, and memory accumulation.
    // The streaming handler above only emits real-time dashboard events (no DB store).
    // Mark as streamed so onOutput skips the agent:output dashboard emission (already shown).
    if (output.result && onOutput) {
      await onOutput({
        status: output.status,
        result: output.result,
        newSessionId: output.newSessionId,
        streamed: true,
        usage: output.usage,
        performance: output.performance,
      });
    } else if (output.usage && onOutput) {
      // Even without result, emit usage for context%
      await onOutput({
        status: output.status,
        result: null,
        usage: output.usage,
        performance: output.performance,
      });
    }

    return output.status === 'error' ? 'error' : 'success';
  } catch (err) {
    clearTimeout(stuckTimer);
    dashboardEvents.emitEvent('agent:exit', {
      groupName: group.name,
      groupFolder: group.folder,
      duration: Date.now() - agentStart,
    });
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`DevenClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = await getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        await saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          // Dashboard groups (dash:*) have no owning channel — they receive
          // messages via the dashboard or via cross-channel routing (e.g. Gmail).
          // The message loop still needs to enqueue them for processing.
          if (!channel && !chatJid.startsWith('dash:')) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = await getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          await preCompressAttachments(messagesToSend, group.folder);
          let formatted = formatMessages(
            messagesToSend,
            TIMEZONE,
            group.folder,
          );

          // Memory: enrich piped messages with relevant memories
          // (inject-once tracking filters out already-loaded memories)
          formatted = await memoryService.enrichMessage(
            chatJid,
            group.folder,
            formatted,
            group.memoryMode || 'full',
            group.memoryScopes,
          );

          if (queue.sendMessage(chatJid, formatted)) {
            // Emit processing event so dashboard shows typing indicator
            dashboardEvents.emitEvent('agent:spawn', {
              groupName: group.name,
              groupFolder: group.folder,
              containerName: 'piped',
            });
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            await saveState();
            // Reset transient close timer — user sent a follow-up
            if (group.isTransient) {
              queue.setTransientTimer(chatJid, TRANSIENT_CLOSE_DELAY_MS);
            }
            // Show typing indicator while the container processes the piped message
            channel
              ?.setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      dbErrorCount++;
      // Exponential backoff on repeated DB errors (e.g. Turso outage)
      if (dbErrorCount <= 3 || dbErrorCount % 30 === 0) {
        logger.error({ err, dbErrorCount }, 'Error in message loop');
      }
      const backoffMs = Math.min(
        POLL_INTERVAL * Math.pow(2, Math.min(dbErrorCount, 5)),
        60000,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    dbErrorCount = 0;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
async function recoverPendingMessages(): Promise<void> {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = await getMessagesSince(
      chatJid,
      sinceTimestamp,
      ASSISTANT_NAME,
    );
    if (pending.length > 0) {
      // Check if agent already responded after the last pending message —
      // if so, the cursor just wasn't saved. Advance it instead of re-processing.
      const allMsgs = await getAllMessagesSince(chatJid, sinceTimestamp);
      const lastPending = pending[pending.length - 1];
      const hasAgentResponse = allMsgs.some(
        (m: { is_bot_message?: boolean; timestamp: string }) =>
          m.is_bot_message && m.timestamp >= lastPending.timestamp,
      );
      if (hasAgentResponse) {
        // Agent already responded — advance cursor, don't re-process
        lastAgentTimestamp[chatJid] = lastPending.timestamp;
        await saveState();
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: agent already responded, advancing cursor',
        );
      } else {
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: found unprocessed messages',
        );
        queue.enqueueMessageCheck(chatJid);
      }
    }
  }
}

const RESTART_FLAG_PATH = path.join(DATA_DIR, 'restart-flag.json');

/** Store + broadcast a service message to every registered group. */
async function broadcastServiceMessage(text: string): Promise<void> {
  const promises = Object.entries(registeredGroups).map(async ([jid, grp]) => {
    const agentName = grp.name || ASSISTANT_NAME;
    const msgId = `svc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = new Date().toISOString();
    await storeMessage({
      id: msgId,
      chat_jid: jid,
      sender: agentName,
      sender_name: agentName,
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
    }).catch((err) =>
      logger.warn({ err }, 'broadcastServiceMessage store failed'),
    );
    dashboardEvents.emitEvent('message:new', {
      chatJid: jid,
      sender: agentName,
      senderName: agentName,
      content: text,
      timestamp,
      isFromMe: false,
    });
  });
  await Promise.all(promises);
}

function writeRestartFlag(reason = 'restart'): void {
  try {
    fs.writeFileSync(
      RESTART_FLAG_PATH,
      JSON.stringify({ ts: Date.now(), reason }),
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to write restart flag');
  }
}

async function checkAndSendOnlineNotification(): Promise<void> {
  if (!fs.existsSync(RESTART_FLAG_PATH)) return;
  try {
    fs.unlinkSync(RESTART_FLAG_PATH);
  } catch {
    /* ignore */
  }
  await broadcastServiceMessage('✅ DevenClaw is back online!').catch((err) =>
    logger.warn({ err }, 'Failed to send back-online notification'),
  );
}

/**
 * Recover orphaned prompt files left behind when the orchestrator
 * was killed mid-dispatch. Fresh prompts (< 2 min) are re-enqueued;
 * stale ones are discarded and a notification is sent to the group.
 */
function recoverOrphanedPrompts(): void {
  const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
  const now = Date.now();

  for (const [jid, group] of Object.entries(registeredGroups)) {
    let inputDir: string;
    try {
      inputDir = path.join(resolveGroupIpcPath(group.folder), 'input');
    } catch {
      continue;
    }
    if (!fs.existsSync(inputDir)) continue;

    const promptFiles = fs
      .readdirSync(inputDir)
      .filter((f) => f.startsWith('prompt-') && f.endsWith('.txt'));

    for (const pf of promptFiles) {
      // Extract nonce: prompt-{nonce}.txt → done-{nonce}.json
      const nonce = pf.slice('prompt-'.length, -'.txt'.length);
      const doneFile = path.join(inputDir, `done-${nonce}.json`);

      if (fs.existsSync(doneFile)) continue; // Already processed

      const promptPath = path.join(inputDir, pf);
      const age = now - fs.statSync(promptPath).mtimeMs;

      if (age < STALE_THRESHOLD_MS) {
        // Fresh — re-enqueue so the message loop picks it up
        logger.info(
          { folder: group.folder, file: pf, ageMs: age },
          'Re-enqueuing fresh orphaned prompt',
        );
        queue.enqueueMessageCheck(jid);
      } else {
        // Stale — discard and notify
        let preview = '';
        try {
          const content = fs.readFileSync(promptPath, 'utf-8');
          // Extract last message content for the notification
          const msgMatch = content.match(/<message[^>]*>([^<]*)<\/message>/g);
          if (msgMatch) {
            const last = msgMatch[msgMatch.length - 1];
            preview = last
              .replace(/<[^>]+>/g, '')
              .trim()
              .slice(0, 80);
          }
        } catch {
          /* ignore */
        }

        logger.warn(
          { folder: group.folder, file: pf, ageMs: age },
          'Discarding stale orphaned prompt',
        );
        fs.unlinkSync(promptPath);

        // Notify the group
        const agentName = group.name || ASSISTANT_NAME;
        const msgId = `svc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const timestamp = new Date().toISOString();
        const notifyText = preview
          ? `Missed message during restart: "${preview}". Please resend if still needed.`
          : 'A message was lost during restart. Please resend if needed.';
        storeMessage({
          id: msgId,
          chat_jid: jid,
          sender: agentName,
          sender_name: agentName,
          content: notifyText,
          timestamp,
          is_from_me: true,
          is_bot_message: true,
        }).catch(() => {});
        dashboardEvents.emitEvent('message:new', {
          chatJid: jid,
          sender: agentName,
          senderName: agentName,
          content: notifyText,
          timestamp,
          isFromMe: false,
        });
      }
    }
  }
}

async function main(): Promise<void> {
  // Recover existing tmux sessions (they survive DevenClaw restarts)
  const recoveredTmux = recoverTmuxSessions();
  if (recoveredTmux.length > 0) {
    logger.info({ sessions: recoveredTmux }, 'Recovered tmux sessions');
  }
  await initDatabase();
  logger.info('Database initialized');
  await initDashboardTokens();
  await initPushService();
  await loadState();

  // Recover orphaned prompts from interrupted restarts
  recoverOrphanedPrompts();
  await memoryService.init();
  // Set owner groups so memory scoping knows which groups get full access
  const ownerFolders = Object.values(registeredGroups)
    .filter((g) => g.isMain)
    .map((g) => g.folder);
  memoryService.setOwnerGroups(ownerFolders);
  restoreRemoteControl();

  // Start Mission Control dashboard (if token is configured)
  let dashServer: import('http').Server | null = null;
  if (DASHBOARD_TOKEN) {
    // Wire chat injection: dashboard can send messages to any group
    setChatSendFn(async (chatJid, text, senderName, stateless) => {
      // Set stateless flag BEFORE enqueuing — processGroupMessages will read it
      if (stateless) statelessPending[chatJid] = true;
      const msgId = `dash-${Date.now()}`;
      const timestamp = new Date().toISOString();
      // Ensure chat entry exists (dashboard-only groups don't have channel-created entries)
      const chatGroup = registeredGroups[chatJid];
      await storeChatMetadata(
        chatJid,
        timestamp,
        chatGroup?.name || chatJid,
        'dashboard',
        false,
      ).catch((err) => logger.warn({ err }, 'storeChatMetadata failed'));
      // Store as a regular user message (NOT is_bot_message) so processGroupMessages can find it
      await storeMessage({
        id: msgId,
        chat_jid: chatJid,
        sender: 'venky',
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: true,
      }).catch((err) => logger.warn({ err }, 'storeMessage failed'));
      // Broadcast to all dashboard clients
      dashboardEvents.emitEvent('message:new', {
        chatJid,
        sender: 'venky',
        senderName,
        content: text,
        timestamp,
        isFromMe: true,
      });
      // Advance the message loop's global cursor so it doesn't re-discover this
      if (timestamp > lastTimestamp) {
        lastTimestamp = timestamp;
        saveState().catch((err) => logger.warn({ err }, 'saveState failed'));
      }
      // Do NOT advance lastAgentTimestamp — processGroupMessages needs to see it
      const group = registeredGroups[chatJid];
      if (group) {
        const dashMsgs: NewMessage[] = [
          {
            id: msgId,
            chat_jid: chatJid,
            sender: 'venky',
            sender_name: senderName,
            content: text,
            timestamp,
            is_from_me: true,
          },
        ];
        await preCompressAttachments(dashMsgs, group.folder);
        const formatted = formatMessages(dashMsgs, TIMEZONE, group.folder);
        dashboardEvents.emitEvent('agent:spawn', {
          groupName: group.name,
          groupFolder: group.folder,
          containerName: 'dashboard',
        });
        // Stateless: always go through processGroupMessages for a fresh session
        // Stateful: try piping to active container first
        if (stateless || !queue.sendMessage(chatJid, formatted)) {
          queue.enqueueMessageCheck(chatJid);
        }
      }
    });

    // Wire memory service for dashboard scope management
    setMemoryService(memoryService);
    setActiveGroupsFn(() => queue.getActiveGroupFolders());

    // Wire session kill: dashboard can stop a group's active container
    setSessionKillFn((chatJid) => {
      queue.closeStdin(chatJid);
    });

    // Wire session interrupt: Ctrl+C to stop current turn, preserve session
    setSessionInterruptFn((chatJid) => {
      const group = registeredGroups[chatJid];
      if (group) {
        interruptSession(group.folder);
        queue.closeStdin(chatJid);
      }
    });

    // Fire push notifications for incoming messages
    dashboardEvents.on(
      'message:new',
      (msg: {
        senderName: string;
        content: string;
        chatJid: string;
        isFromMe: boolean;
      }) => {
        if (msg.isFromMe) return;
        sendPushNotification({
          title: msg.senderName || 'Mission Control',
          body: msg.content.slice(0, 120),
          tag: msg.chatJid,
          url: '/',
        }).catch(() => {});
      },
    );

    dashServer = await startDashboard(DASHBOARD_PORT, {
      getActiveGroupFolders: () => queue.getActiveGroupFolders(),
    });
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await broadcastServiceMessage(
      '🔄 DevenClaw is restarting, back in a moment...',
    ).catch(() => {});
    writeRestartFlag(signal);
    dashServer?.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg).catch((err) =>
        logger.warn({ err }, 'storeMessage failed'),
      );
      dashboardEvents.emitEvent('message:new', {
        chatJid,
        sender: msg.sender,
        senderName: msg.sender_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isFromMe: msg.is_from_me || false,
      });
      // Dashboard groups (dash:*) have no owning channel, so the message loop
      // skips them. Enqueue directly so Gmail (and future cross-channel) messages
      // routed to dashboard groups get processed immediately.
      if (chatJid.startsWith('dash:') && registeredGroups[chatJid]) {
        queue.enqueueMessageCheck(chatJid);
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup).catch(
        (err) => logger.warn({ err }, 'storeChatMetadata failed'),
      ),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0 && !DASHBOARD_TOKEN) {
    logger.fatal('No channels connected and no dashboard configured');
    process.exit(1);
  }
  if (channels.length === 0) {
    logger.info('No channels connected — dashboard-only mode');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (!text) return;
      const channel = findChannel(channels, jid);
      if (channel) {
        await channel.sendMessage(jid, text);
      } else {
        // Dashboard-only mode
        dashboardEvents.emitEvent('message:new', {
          chatJid: jid,
          sender: ASSISTANT_NAME,
          senderName: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          isFromMe: false,
        });
      }
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (channel) {
        return channel.sendMessage(jid, text);
      }
      // Dashboard-only mode: broadcast via socket, store in DB
      const grp = registeredGroups[jid];
      const agentName = grp?.name || ASSISTANT_NAME;
      dashboardEvents.emitEvent('message:new', {
        chatJid: jid,
        sender: agentName,
        senderName: agentName,
        content: text,
        timestamp: new Date().toISOString(),
        isFromMe: false,
      });
    },
    sendFile: async (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (channel) {
        if (!channel.sendFile) {
          return channel.sendMessage(jid, caption || `[File: ${filePath}]`);
        }
        return channel.sendFile(jid, filePath, caption);
      }
      // Dashboard-only: copy file to group attachments, store message, broadcast
      const fileGrp = registeredGroups[jid];
      const agentName = fileGrp?.name || ASSISTANT_NAME;
      const filename = path.basename(filePath);
      let content = caption || `[File: ${filename}]`;

      if (fileGrp && fs.existsSync(filePath)) {
        // Copy file to group's attachments folder so /api/files/ can serve it
        const attachDir = path.join(GROUPS_DIR, fileGrp.folder, 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });
        const destPath = path.join(attachDir, filename);
        fs.copyFileSync(filePath, destPath);
        // Format as [Document: filename] so ChatView can render it
        content = `[Document: ${filename}]${caption ? ' ' + caption : ''}`;
        logger.info(
          { jid, filename, destPath },
          'File copied to attachments for dashboard',
        );
      }

      const msgId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const timestamp = new Date().toISOString();
      storeMessage({
        id: msgId,
        chat_jid: jid,
        sender: agentName,
        sender_name: agentName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: true,
      }).catch((err) => logger.warn({ err }, 'storeMessage failed'));
      dashboardEvents.emitEvent('message:new', {
        chatJid: jid,
        sender: agentName,
        senderName: agentName,
        content,
        timestamp,
        isFromMe: false,
      });
    },
    registeredGroups: () => registeredGroups,
    registerGroup: (jid, group) => {
      registerGroup(jid, group).catch((err) =>
        logger.warn({ err, jid }, 'registerGroup failed'),
      );
    },
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onMemoryWriteBack: (groupFolder, text) => {
      // Find the group's memoryUserId for proper write-back isolation
      getAllRegisteredGroups()
        .then((groups) => {
          const group = Object.values(groups).find(
            (g) => g.folder === groupFolder,
          );
          memoryService
            .writeBack(groupFolder, text, group?.memoryUserId)
            .catch((err) =>
              logger.warn(
                { err, groupFolder },
                'Pre-compact memory write-back failed',
              ),
            );
        })
        .catch((err) => logger.warn({ err }, 'getAllRegisteredGroups failed'));
    },
    onShutdown: async () => {
      await broadcastServiceMessage(
        '🔄 DevenClaw is restarting, back in a moment...',
      ).catch(() => {});
      writeRestartFlag('restart_service');
    },
    enqueueMessageCheck: (chatJid: string) => {
      queue.enqueueMessageCheck(chatJid);
    },
    runCommand: async (commandName, groupFolder, chatJid, input) => {
      const sendMsg = async (text: string) => {
        const channel = findChannel(channels, chatJid);
        if (channel) {
          await channel.sendMessage(chatJid, text);
        } else {
          const grp = registeredGroups[chatJid];
          const agentName = grp?.name || ASSISTANT_NAME;
          const msgId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const timestamp = new Date().toISOString();
          storeMessage({
            id: msgId,
            chat_jid: chatJid,
            sender: agentName,
            sender_name: agentName,
            content: text,
            timestamp,
            is_from_me: false,
            is_bot_message: true,
          }).catch(() => {});
          dashboardEvents.emitEvent('message:new', {
            chatJid,
            sender: agentName,
            senderName: agentName,
            content: text,
            timestamp,
            isFromMe: false,
          });
        }
      };
      runCommand({
        commandName,
        groupFolder,
        chatJid,
        input,
        sendMessage: sendMsg,
      }).catch((err) =>
        logger.warn({ err, commandName, groupFolder }, 'runCommand failed'),
      );
    },
    onTasksChanged: () => {
      getAllTasks()
        .then((tasks) => {
          const taskRows = tasks.map((t) => ({
            id: t.id,
            groupFolder: t.group_folder,
            prompt: t.prompt,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
          }));
          for (const group of Object.values(registeredGroups)) {
            writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
          }
        })
        .catch((err) => logger.warn({ err }, 'getAllTasks failed'));
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  setTimeout(
    () =>
      checkAndSendOnlineNotification().catch((err) =>
        logger.warn({ err }, 'back-online notify failed'),
      ),
    5000,
  );
  recoverPendingMessages().catch((err) =>
    logger.warn({ err }, 'recoverPendingMessages failed'),
  );
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start DevenClaw');
    process.exit(1);
  });
}
