import { EventEmitter } from 'events';

export interface DashboardEventMap {
  'message:new': {
    chatJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
  };
  'agent:spawn': {
    groupName: string;
    groupFolder: string;
    containerName: string;
  };
  'agent:output': { groupName: string; groupFolder: string; text: string };
  'agent:idle': { groupName: string; groupFolder: string };
  'agent:exit': { groupName: string; groupFolder: string; duration?: number };
  'container:log': {
    groupName: string;
    groupFolder: string;
    line: string;
    stream: 'stdout' | 'stderr';
  };
  'draft:update': { chatJid: string; content: string };
  'task:complete': { taskId: string; status: string; duration: number };
  'context:update': { groupFolder: string; percent: number; sizeKB: number };
}

class DashboardEventHub extends EventEmitter {
  emitEvent<K extends keyof DashboardEventMap>(
    event: K,
    data: DashboardEventMap[K],
  ): void {
    this.emit(event, data);
  }
}

export const dashboardEvents = new DashboardEventHub();
