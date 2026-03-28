import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './ipc-snapshots.js';
import {
  createTask,
  createTodo,
  deleteTask,
  deleteTodo,
  deleteReminder,
  getTaskById,
  getTodoById,
  getReminderById,
  storeMessage,
  updateTask,
  updateTodo,
  updateReminder,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile?: (jid: string, filePath: string, caption?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => Promise<AvailableGroup[]>;
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  onMemoryWriteBack?: (groupFolder: string, text: string) => void;
  onShutdown?: () => Promise<void>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // File attachment: resolve path and validate it's within allowed directories
                  if (data.filePath && deps.sendFile) {
                    const groupDir = path.join(
                      DATA_DIR,
                      '..',
                      'groups',
                      sourceGroup,
                    );
                    // Translate container paths to host paths:
                    // /workspace/group/... → groups/{sourceGroup}/...
                    // /workspace/project/groups/... → groups/...
                    let hostPath = data.filePath;
                    if (hostPath.startsWith('/workspace/group/')) {
                      hostPath = path.join(
                        groupDir,
                        hostPath.slice('/workspace/group/'.length),
                      );
                    } else if (
                      hostPath.startsWith('/workspace/project/groups/')
                    ) {
                      hostPath = path.join(
                        DATA_DIR,
                        '..',
                        'groups',
                        hostPath.slice('/workspace/project/groups/'.length),
                      );
                    }
                    const resolved = path.resolve(groupDir, hostPath);
                    // Security: only allow files from within the group folder or /tmp
                    if (
                      resolved.startsWith(path.resolve(groupDir)) ||
                      resolved.startsWith('/tmp/')
                    ) {
                      await deps.sendFile(
                        data.chatJid,
                        resolved,
                        data.text || undefined,
                      );
                      logger.info(
                        { chatJid: data.chatJid, sourceGroup, file: resolved },
                        'IPC file sent',
                      );
                    } else {
                      logger.warn(
                        { chatJid: data.chatJid, filePath: data.filePath },
                        'IPC file path outside allowed directory',
                      );
                      await deps.sendMessage(data.chatJid, data.text);
                    }
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  // Persist IPC messages in DB so they survive page refresh
                  const groupName = targetGroup?.name || sourceGroup;
                  storeMessage({
                    id: `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    chat_jid: data.chatJid,
                    sender: data.sender || groupName,
                    sender_name: data.sender || groupName,
                    content: data.text,
                    timestamp: data.timestamp || new Date().toISOString(),
                    is_from_me: false,
                    is_bot_message: true,
                  }).catch((err) =>
                    logger.warn({ err }, 'Failed to store IPC message'),
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process memory write-back files (pre-compaction fact extraction)
      if (deps.onMemoryWriteBack) {
        const memoryDir = path.join(ipcBaseDir, sourceGroup, 'memory');
        try {
          if (fs.existsSync(memoryDir)) {
            const memFiles = fs
              .readdirSync(memoryDir)
              .filter((f) => f.endsWith('.json'));
            for (const file of memFiles) {
              const filePath = path.join(memoryDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (
                  (data.type === 'pre_compact_writeback' ||
                    data.type === 'save_memory') &&
                  data.groupFolder &&
                  data.text
                ) {
                  deps.onMemoryWriteBack(data.groupFolder, data.text);
                  logger.info(
                    { sourceGroup, type: data.type },
                    'Memory write-back triggered',
                  );
                }
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error(
                  { file, sourceGroup, err },
                  'Error processing memory IPC file',
                );
                try {
                  fs.unlinkSync(filePath);
                } catch {
                  /* ignore */
                }
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC memory directory',
          );
        }
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: Record<string, any> & { type: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        await createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = await getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          await updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = await getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          await updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = await getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          await deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = await getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        await updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = await deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          requiresTrigger: data.requiresTrigger,
          isTransient: data.isTransient,
          workDir: data.workDir || undefined,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'restart_service':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized restart_service attempt blocked',
        );
        break;
      }
      logger.info(
        { sourceGroup, reason: data.reason },
        'Graceful restart requested via IPC',
      );
      // Notify all chats, then exit. launchd KeepAlive restarts automatically.
      (async () => {
        try {
          await deps.onShutdown?.();
        } catch (err) {
          logger.warn({ err }, 'onShutdown hook failed');
        }
        setTimeout(() => {
          logger.info('Exiting for restart...');
          process.exit(0);
        }, 1500);
      })();
      break;

    // ── Todos ──
    case 'add_todo': {
      const group = registeredGroups[
        Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid].folder === sourceGroup,
        ) || ''
      ];
      const userId = group?.memoryUserId || 'venky';
      const todoId = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      await createTodo({
        id: todoId,
        user_id: userId,
        title: data.title,
        data: data.data || null,
        status: 'pending',
        priority: data.priority || 'medium',
        due_date: data.due_date ? new Date(data.due_date).toISOString() : null,
        remind_at: data.remind_at ? new Date(data.remind_at).toISOString() : null,
        recurrence: data.recurrence || null,
        reminder_fired_at: null,
        created_by: sourceGroup,
        created_at: now,
        updated_at: now,
      });
      logger.info({ todoId, sourceGroup }, 'Todo created via IPC');
      break;
    }

    case 'update_todo': {
      if (data.todoId) {
        const todo = await getTodoById(data.todoId);
        if (todo) {
          const updates: Record<string, string> = {};
          if (data.title) updates.title = data.title;
          if (data.data) updates.data = data.data;
          if (data.status) updates.status = data.status;
          if (data.priority) updates.priority = data.priority;
          if (data.due_date) updates.due_date = data.due_date;
          await updateTodo(data.todoId, updates);
          logger.info({ todoId: data.todoId, sourceGroup }, 'Todo updated via IPC');
        }
      }
      break;
    }

    case 'delete_todo': {
      if (data.todoId) {
        await deleteTodo(data.todoId);
        logger.info({ todoId: data.todoId, sourceGroup }, 'Todo deleted via IPC');
      }
      break;
    }

    // ── Reminders (creates a todo with remind_at) ──
    case 'add_reminder': {
      const remGroup = registeredGroups[
        Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid].folder === sourceGroup,
        ) || ''
      ];
      const remUserId = remGroup?.memoryUserId || 'venky';
      const remTodoId = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const remNow = new Date().toISOString();
      const remindAtUtc = data.remind_at ? new Date(data.remind_at).toISOString() : remNow;
      await createTodo({
        id: remTodoId,
        user_id: remUserId,
        title: data.title,
        data: data.data || null,
        status: 'pending',
        priority: 'medium',
        due_date: null,
        remind_at: remindAtUtc,
        recurrence: data.recurrence || null,
        reminder_fired_at: null,
        created_by: sourceGroup,
        created_at: remNow,
        updated_at: remNow,
      });
      logger.info({ todoId: remTodoId, sourceGroup }, 'Reminder todo created via IPC');
      break;
    }

    case 'update_reminder': {
      if (data.reminderId) {
        const rem = await getReminderById(data.reminderId);
        if (rem) {
          const updates: Record<string, string> = {};
          if (data.title) updates.title = data.title;
          if (data.data) updates.data = data.data;
          if (data.remind_at) updates.remind_at = data.remind_at;
          if (data.recurrence) updates.recurrence = data.recurrence;
          await updateReminder(data.reminderId, updates);
        }
      }
      break;
    }

    case 'dismiss_reminder': {
      if (data.reminderId) {
        await updateReminder(data.reminderId, { status: 'dismissed' });
      }
      break;
    }

    case 'snooze_reminder': {
      if (data.reminderId && data.snooze_until) {
        await updateReminder(data.reminderId, { status: 'snoozed', snoozed_until: data.snooze_until });
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
