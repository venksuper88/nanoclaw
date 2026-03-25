/**
 * Memory Service for NanoClaw
 *
 * Wraps mem0 to provide inject-once memory tracking and write-back.
 * Multi-user: each group has its own memoryUserId for private memories.
 * Shared memories live under userId 'shared' with scope tags.
 * Owner groups see everything. Non-owners see their private + whitelisted shared scopes.
 *
 * Architecture: runs on the host side (not in containers).
 * Uses Ollama locally for LLM (fact extraction) + embeddings (search).
 * Degrades gracefully if Ollama is unavailable.
 */
import {
  MEMORY_EMBED_MODEL,
  MEMORY_ENABLED,
  MEMORY_LLM_MODEL,
  OLLAMA_BASE_URL,
} from './config.js';
import { getAllScopeDefs } from './db.js';
import { logger } from './logger.js';

// Lazy import: mem0ai eagerly imports all provider SDKs
type Memory = InstanceType<typeof import('mem0ai/oss').Memory>;
interface MemoryItem {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, any>;
}
interface SearchResult {
  results: MemoryItem[];
}

const MAX_WRITEBACK_CHARS = 4000;
const RELEVANCE_THRESHOLD = 0.3;
const SEARCH_LIMIT = 10;
const DEFAULT_USER_ID = 'venky';
const SHARED_USER_ID = 'shared';

export type MemoryScope = 'global' | 'private' | string[]; // string[] = list of scope tags

export class MemoryService {
  private memory: Memory | null = null;
  private available = false;

  /** Per-session tracking: groupFolder -> Set of memory IDs already injected */
  private sessions = new Map<string, Set<string>>();

  /** Per-session conversation accumulator for write-back */
  private conversationBuffers = new Map<string, string[]>();

  /** Group folder -> isOwnerGroup mapping */
  private ownerGroups = new Set<string>();

  setOwnerGroups(folders: string[]): void {
    this.ownerGroups = new Set(folders);
  }

  async init(): Promise<void> {
    if (!MEMORY_ENABLED) {
      logger.info('Memory service disabled via MEMORY_ENABLED=false');
      return;
    }

    try {
      const { Memory } = await import('mem0ai/oss');
      this.memory = new Memory({
        llm: {
          provider: 'ollama',
          config: {
            model: MEMORY_LLM_MODEL,
            url: OLLAMA_BASE_URL,
          },
        },
        embedder: {
          provider: 'ollama',
          config: {
            model: MEMORY_EMBED_MODEL,
            url: OLLAMA_BASE_URL,
          },
        },
        vectorStore: {
          provider: 'memory',
          config: {
            collectionName: 'nanoclaw_memories',
          },
        },
        disableHistory: false,
      });

      await this.memory.getAll({ userId: '__probe__' });
      this.available = true;
      logger.info('Memory service initialized (mem0 + Ollama)');
    } catch (err) {
      this.available = false;
      this.memory = null;
      logger.warn(
        { err },
        'Memory service unavailable (Ollama not running?), continuing without memory',
      );
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  startSession(groupFolder: string): void {
    this.sessions.set(groupFolder, new Set());
    this.conversationBuffers.set(groupFolder, []);
  }

  endSession(groupFolder: string): void {
    this.sessions.delete(groupFolder);
    this.conversationBuffers.delete(groupFolder);
  }

  /**
   * Search mem0 for relevant memories using dual search pattern:
   * 1. Private: search userId = group's memoryUserId (all their memories)
   * 2. Shared: search userId = 'shared', filtered by group's sharedMemoryScopes
   *
   * Owner groups see all shared memories regardless of scope.
   */
  async enrichMessage(
    _chatJid: string,
    groupFolder: string,
    text: string,
    memoryMode: 'full' | 'local' | 'none' = 'full',
    memoryScopes?: string[],
    memoryUserId?: string,
  ): Promise<string> {
    if (!this.available || !this.memory) return text;
    if (memoryMode === 'none' || memoryMode === 'local') return text;

    const userId = memoryUserId || DEFAULT_USER_ID;
    const isOwner = this.ownerGroups.has(groupFolder);

    try {
      // Search 1: Private memories (user's own pool)
      const privateResult: SearchResult = await this.memory.search(text, {
        userId,
        limit: SEARCH_LIMIT,
      });

      // Search 2: Shared memories (common pool)
      const sharedResult: SearchResult = await this.memory.search(text, {
        userId: SHARED_USER_ID,
        limit: SEARCH_LIMIT,
      });

      const loaded = this.sessions.get(groupFolder);

      // Filter private memories: all pass (it's your own store)
      const privateMemories = (privateResult.results || []).filter(
        (m) =>
          (m.score === undefined || m.score > RELEVANCE_THRESHOLD) &&
          (!loaded || !loaded.has(m.id)),
      );

      // Filter shared memories: owner sees all, non-owner filtered by scopes
      const sharedMemories = (sharedResult.results || []).filter((m) => {
        if (m.score !== undefined && m.score <= RELEVANCE_THRESHOLD)
          return false;
        if (loaded && loaded.has(m.id)) return false;
        if (isOwner) return true; // Owner sees all shared
        return this.matchesSharedScopes(m, memoryScopes);
      });

      const newMemories = [...privateMemories, ...sharedMemories];

      if (newMemories.length === 0) return text;

      if (loaded) {
        for (const m of newMemories) loaded.add(m.id);
      }

      const memoryBlock = newMemories
        .map((m) => `<memory>${m.memory}</memory>`)
        .join('\n');

      logger.info(
        {
          groupFolder,
          userId,
          privateCount: privateMemories.length,
          sharedCount: sharedMemories.length,
          totalLoaded: loaded?.size ?? 0,
        },
        'Injecting memories (dual search)',
      );

      return `<recalled_memories>\n${memoryBlock}\n</recalled_memories>\n\n${text}`;
    } catch (err) {
      logger.warn(
        { err, groupFolder },
        'Memory search failed, skipping enrichment',
      );
      return text;
    }
  }

  /**
   * Check if a shared memory's scope matches the group's allowed scopes.
   * Empty memoryScopes = no shared access (must explicitly opt in).
   */
  private matchesSharedScopes(
    memory: MemoryItem,
    memoryScopes?: string[],
  ): boolean {
    if (!memoryScopes || memoryScopes.length === 0) return false;
    const scope = memory.metadata?.scope;
    if (!scope) return false; // Shared memories must have a scope tag
    if (typeof scope === 'string') return memoryScopes.includes(scope);
    if (Array.isArray(scope))
      return scope.some((s) => memoryScopes.includes(s));
    return false;
  }

  accumulateOutput(groupFolder: string, text: string): void {
    const buffer = this.conversationBuffers.get(groupFolder);
    if (buffer) buffer.push(text);
  }

  /**
   * Write-back: extract facts from conversation and store under group's memoryUserId.
   * Never writes to 'shared' automatically — that's a manual owner action.
   */
  async writeBack(
    groupFolder: string,
    userPrompt: string,
    memoryUserId?: string,
  ): Promise<void> {
    if (!this.available || !this.memory) return;

    const buffer = this.conversationBuffers.get(groupFolder);
    if (!buffer || buffer.length === 0) return;

    const userId = memoryUserId || DEFAULT_USER_ID;

    try {
      const responses = buffer.join('\n');
      let conversationText = `User messages:\n${userPrompt}\n\nAssistant responses:\n${responses}`;

      if (conversationText.length > MAX_WRITEBACK_CHARS) {
        const keepStart = 1500;
        const keepEnd = MAX_WRITEBACK_CHARS - keepStart;
        conversationText =
          conversationText.slice(0, keepStart) +
          '\n[...truncated...]\n' +
          conversationText.slice(-keepEnd);
      }

      await this.memory.add(conversationText, {
        userId,
        metadata: { groupFolder },
      });
      logger.debug(
        { groupFolder, userId, responseCount: buffer.length },
        'Memory write-back completed',
      );
    } catch (err) {
      logger.warn({ err, groupFolder }, 'Memory write-back failed');
    }
  }

  /**
   * Get all memories for the dashboard (owner only).
   * Returns both private (all userIds) and shared memories.
   */
  async getAllMemories(): Promise<MemoryItem[]> {
    if (!this.available || !this.memory) return [];
    try {
      // Get memories for all known userIds
      const defaultResult = await this.memory.getAll({
        userId: DEFAULT_USER_ID,
      });
      const sharedResult = await this.memory.getAll({
        userId: SHARED_USER_ID,
      });

      const defaultMemories = (defaultResult.results || []).map(
        (m: MemoryItem) => ({
          ...m,
          metadata: { ...m.metadata, _userId: DEFAULT_USER_ID },
        }),
      );
      const sharedMemories = (sharedResult.results || []).map(
        (m: MemoryItem) => ({
          ...m,
          metadata: { ...m.metadata, _userId: SHARED_USER_ID },
        }),
      );

      return [...defaultMemories, ...sharedMemories];
    } catch {
      return [];
    }
  }

  /**
   * Move a memory to the shared pool with a scope tag.
   * Deletes from original userId, re-adds under 'shared' with scope.
   */
  async moveToShared(
    memoryId: string,
    scope: string,
    sourceUserId: string = DEFAULT_USER_ID,
  ): Promise<void> {
    if (!this.available || !this.memory)
      throw new Error('Memory service unavailable');

    const existing = await this.memory.get(memoryId);
    if (!existing) throw new Error('Memory not found');

    const text = existing.memory;
    const metadata: Record<string, any> = {
      ...(existing.metadata || {}),
      scope,
      movedFrom: sourceUserId,
    };
    delete metadata._userId;

    await this.memory.delete(memoryId);
    await this.memory.add(text, {
      userId: SHARED_USER_ID,
      infer: false,
      metadata,
    });
    logger.info({ memoryId, scope, sourceUserId }, 'Memory moved to shared');
  }

  /**
   * Auto-suggest a scope tag for a memory using Ollama.
   */
  async suggestScope(memoryText: string): Promise<string | null> {
    try {
      const scopes = await getAllScopeDefs();
      if (scopes.length === 0) return null;

      const scopeList = scopes
        .map((s) => `- ${s.name}: ${s.description}`)
        .join('\n');

      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MEMORY_LLM_MODEL,
          prompt: `Given this memory/fact:\n"${memoryText}"\n\nWhich scope tag best fits? Pick exactly one:\n${scopeList}\n\nRespond with ONLY the scope name, nothing else.`,
          stream: false,
        }),
      });
      const data = (await response.json()) as { response?: string };
      const suggested = data.response?.trim().toLowerCase();
      // Validate it's an actual scope
      if (suggested && scopes.some((s) => s.name === suggested)) {
        return suggested;
      }
      return scopes[0]?.name || null;
    } catch (err) {
      logger.warn({ err }, 'Scope suggestion failed');
      return null;
    }
  }

  /**
   * Update a memory's scope metadata (for memories already in shared).
   */
  async updateMemoryScope(
    memoryId: string,
    scope: MemoryScope,
    userId: string = DEFAULT_USER_ID,
  ): Promise<void> {
    if (!this.available || !this.memory)
      throw new Error('Memory service unavailable');
    const existing = await this.memory.get(memoryId);
    if (!existing) throw new Error('Memory not found');
    const text = existing.memory;
    const metadata: Record<string, any> = {
      ...(existing.metadata || {}),
      scope,
    };
    delete metadata._userId;
    await this.memory.delete(memoryId);
    await this.memory.add(text, { userId, infer: false, metadata });
    logger.info({ memoryId, scope }, 'Memory scope updated');
  }

  /**
   * Delete a memory.
   */
  async deleteMemory(memoryId: string): Promise<void> {
    if (!this.available || !this.memory)
      throw new Error('Memory service unavailable');
    await this.memory.delete(memoryId);
    logger.info({ memoryId }, 'Memory deleted');
  }
}
