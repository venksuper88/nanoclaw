import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DASHBOARD_PORT,
  DASHBOARD_TOKEN,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRANSIENT_CLOSE_DELAY_MS,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { dashboardEvents } from './dashboard/events.js';
import { setChatSendFn, setMemoryService, setSessionKillFn } from './dashboard/routes.js';
import { startDashboard } from './dashboard/server.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
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
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const memoryService = new MemoryService();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
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
  setRegisteredGroup(jid, group);

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
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
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
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

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

  const rawPrompt = formatMessages(missedMessages, TIMEZONE);

  // Memory: start session tracking and enrich with relevant memories
  memoryService.startSession(group.folder);
  const prompt = await memoryService.enrichMessage(
    chatJid,
    group.folder,
    rawPrompt,
    group.memoryMode || 'full',
    group.memoryScopes,
  );

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

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
    } else if (group.isMain) {
      // Main group: never auto-close — container stays alive until service restart
      if (idleTimer) clearTimeout(idleTimer);
    } else {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        queue.closeStdin(chatJid);
      }, IDLE_TIMEOUT);
    }
  };

  await channel?.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
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
        dashboardEvents.emitEvent('agent:output', {
          groupName: group.name,
          groupFolder: group.folder,
          text,
        });
        // Store agent response in DB so dashboard can load it later
        const agentMsgId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        storeMessage({
          id: agentMsgId,
          chat_jid: chatJid,
          sender: ASSISTANT_NAME,
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
        await channel?.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Emit context usage estimate after each output
      try {
        const transcriptDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude', 'projects', '-workspace-group');
        const sid = sessions[group.folder];
        if (sid && fs.existsSync(transcriptDir)) {
          const transcriptFile = path.join(transcriptDir, `${sid}.jsonl`);
          if (fs.existsSync(transcriptFile)) {
            const content = fs.readFileSync(transcriptFile, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            let activeStartIdx = 0;
            for (let i = lines.length - 1; i >= 0; i--) {
              if (lines[i].includes('"subtype":"init"') && lines[i].includes('"session_id"')) {
                activeStartIdx = i;
                break;
              }
            }
            let activeBytes = 0;
            for (let i = activeStartIdx; i < lines.length; i++) {
              if (lines[i].includes('"type":"user"') || lines[i].includes('"type":"assistant"') || lines[i].includes('"type":"result"')) {
                activeBytes += Buffer.byteLength(lines[i]);
              }
            }
            const sizeKB = Math.round(activeBytes / 1024);
            const percent = Math.min(100, Math.round((activeBytes / 819200) * 100));
            dashboardEvents.emitEvent('context:update', { groupFolder: group.folder, percent, sizeKB });
          }
        }
      } catch { /* ignore */ }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

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
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    memoryService.endSession(group.folder);
    return false;
  }

  // Memory: extract facts from conversation and store for future retrieval
  await memoryService.writeBack(group.folder, rawPrompt);
  memoryService.endSession(group.folder);

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = group.isTransient ? undefined : sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && !group.isTransient) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  const agentStart = Date.now();
  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => {
        dashboardEvents.emitEvent('agent:spawn', {
          groupName: group.name,
          groupFolder: group.folder,
          containerName,
        });
        queue.registerProcess(chatJid, proc, containerName, group.folder);
      },
      wrappedOnOutput,
    );

    dashboardEvents.emitEvent('agent:exit', {
      groupName: group.name,
      groupFolder: group.folder,
      duration: Date.now() - agentStart,
    });

    if (output.newSessionId && !group.isTransient) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
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

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

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
          if (!channel) {
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
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          let formatted = formatMessages(messagesToSend, TIMEZONE);

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
            saveState();
            // Reset transient close timer — user sent a follow-up
            if (group.isTransient) {
              queue.setTransientTimer(chatJid, TRANSIENT_CLOSE_DELAY_MS);
            }
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
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
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  await memoryService.init();
  // Set owner groups so memory scoping knows which groups get full access
  const ownerFolders = Object.values(registeredGroups)
    .filter(g => g.isMain)
    .map(g => g.folder);
  memoryService.setOwnerGroups(ownerFolders);
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start Mission Control dashboard (if token is configured)
  let dashServer: import('http').Server | null = null;
  if (DASHBOARD_TOKEN) {
    // Wire chat injection: dashboard can send messages to any group
    setChatSendFn((chatJid, text, senderName) => {
      const msgId = `dash-${Date.now()}`;
      const timestamp = new Date().toISOString();
      // Ensure chat entry exists (dashboard-only groups don't have channel-created entries)
      const chatGroup = registeredGroups[chatJid];
      storeChatMetadata(chatJid, timestamp, chatGroup?.name || chatJid, 'dashboard', false);
      // Store as a regular user message (NOT is_bot_message) so processGroupMessages can find it
      storeMessage({
        id: msgId,
        chat_jid: chatJid,
        sender: 'venky',
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: true,
      });
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
        saveState();
      }
      // Do NOT advance lastAgentTimestamp — processGroupMessages needs to see it
      const group = registeredGroups[chatJid];
      if (group) {
        const formatted = formatMessages(
          [{ id: msgId, chat_jid: chatJid, sender: 'venky', sender_name: senderName, content: text, timestamp, is_from_me: true }],
          TIMEZONE,
        );
        dashboardEvents.emitEvent('agent:spawn', {
          groupName: group.name,
          groupFolder: group.folder,
          containerName: 'dashboard',
        });
        // Try piping to active container first
        if (!queue.sendMessage(chatJid, formatted)) {
          // No active container — use the standard message processing path
          queue.enqueueMessageCheck(chatJid);
        }
      }
    });

    // Wire memory service for dashboard scope management
    setMemoryService(memoryService);

    // Wire session kill: dashboard can stop a group's active container
    setSessionKillFn((chatJid) => {
      queue.closeStdin(chatJid);
    });

    dashServer = await startDashboard(DASHBOARD_PORT);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
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
      storeMessage(msg);
      dashboardEvents.emitEvent('message:new', {
        chatJid,
        sender: msg.sender,
        senderName: msg.sender_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isFromMe: msg.is_from_me || false,
      });
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
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
          chatJid: jid, sender: ASSISTANT_NAME, senderName: ASSISTANT_NAME,
          content: text, timestamp: new Date().toISOString(), isFromMe: false,
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
      dashboardEvents.emitEvent('message:new', {
        chatJid: jid,
        sender: ASSISTANT_NAME,
        senderName: ASSISTANT_NAME,
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
      // Dashboard-only: just broadcast the caption
      dashboardEvents.emitEvent('message:new', {
        chatJid: jid,
        sender: ASSISTANT_NAME,
        senderName: ASSISTANT_NAME,
        content: caption || `[File: ${filePath}]`,
        timestamp: new Date().toISOString(),
        isFromMe: false,
      });
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
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
      memoryService.writeBack(groupFolder, text).catch((err) =>
        logger.warn({ err, groupFolder }, 'Pre-compact memory write-back failed'),
      );
    },
    onTasksChanged: () => {
      const tasks = getAllTasks();
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
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
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
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
