/**
 * Memory Service for NanoClaw
 *
 * Wraps mem0 to provide inject-once memory tracking and write-back.
 * Token usage flattens over long conversations: early messages pay
 * injection cost, later messages pay near-zero because memories are
 * already in the context window.
 *
 * Architecture: runs on the host side (not in containers).
 * Uses Ollama locally for LLM (fact extraction) + embeddings (search).
 * Degrades gracefully if Ollama is unavailable.
 */
import { Memory, type MemoryItem, type SearchResult } from 'mem0ai/oss';

import {
  MEMORY_EMBED_MODEL,
  MEMORY_ENABLED,
  MEMORY_LLM_MODEL,
  OLLAMA_BASE_URL,
} from './config.js';
import { logger } from './logger.js';

const MAX_WRITEBACK_CHARS = 4000;
const RELEVANCE_THRESHOLD = 0.3;
const SEARCH_LIMIT = 5;

export class MemoryService {
  private memory: Memory | null = null;
  private available = false;

  /** Per-session tracking: groupFolder → Set of memory IDs already injected */
  private sessions = new Map<string, Set<string>>();

  /** Per-session conversation accumulator for write-back */
  private conversationBuffers = new Map<string, string[]>();

  async init(): Promise<void> {
    if (!MEMORY_ENABLED) {
      logger.info('Memory service disabled via MEMORY_ENABLED=false');
      return;
    }

    try {
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

      // Probe Ollama connectivity — this triggers auto-initialization
      // (dimension detection, vector store creation)
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

  /**
   * Start tracking injected memories for a new container session.
   * Call when a container spawns for a group.
   */
  startSession(groupFolder: string): void {
    this.sessions.set(groupFolder, new Set());
    this.conversationBuffers.set(groupFolder, []);
  }

  /**
   * Clean up session tracking state.
   * Call after write-back completes or on error.
   */
  endSession(groupFolder: string): void {
    this.sessions.delete(groupFolder);
    this.conversationBuffers.delete(groupFolder);
  }

  /**
   * Search mem0 for relevant memories and prepend any that haven't
   * been injected yet in this session. Returns enriched text or
   * original text unchanged if no new memories found.
   */
  async enrichMessage(
    _chatJid: string,
    groupFolder: string,
    text: string,
  ): Promise<string> {
    if (!this.available || !this.memory) return text;

    try {
      const result: SearchResult = await this.memory.search(text, {
        userId: groupFolder,
        limit: SEARCH_LIMIT,
      });

      const memories: MemoryItem[] = result.results || [];
      const loaded = this.sessions.get(groupFolder);

      const newMemories = memories.filter(
        (m) =>
          (m.score === undefined || m.score > RELEVANCE_THRESHOLD) &&
          (!loaded || !loaded.has(m.id)),
      );

      if (newMemories.length === 0) return text;

      // Mark as injected
      if (loaded) {
        for (const m of newMemories) loaded.add(m.id);
      }

      const memoryBlock = newMemories
        .map((m) => `<memory>${m.memory}</memory>`)
        .join('\n');

      logger.info(
        {
          groupFolder,
          newCount: newMemories.length,
          totalLoaded: loaded?.size ?? 0,
        },
        'Injecting new memories',
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
   * Buffer agent output text for write-back at session end.
   */
  accumulateOutput(groupFolder: string, text: string): void {
    const buffer = this.conversationBuffers.get(groupFolder);
    if (buffer) buffer.push(text);
  }

  /**
   * Extract facts from the conversation and store in mem0.
   * Truncates long conversations to avoid overwhelming Ollama.
   */
  async writeBack(groupFolder: string, userPrompt: string): Promise<void> {
    if (!this.available || !this.memory) return;

    const buffer = this.conversationBuffers.get(groupFolder);
    if (!buffer || buffer.length === 0) return;

    try {
      const responses = buffer.join('\n');
      let conversationText = `User messages:\n${userPrompt}\n\nAssistant responses:\n${responses}`;

      // Truncate from the middle if too long
      if (conversationText.length > MAX_WRITEBACK_CHARS) {
        const keepStart = 1500;
        const keepEnd = MAX_WRITEBACK_CHARS - keepStart;
        conversationText =
          conversationText.slice(0, keepStart) +
          '\n[...truncated...]\n' +
          conversationText.slice(-keepEnd);
      }

      await this.memory.add(conversationText, { userId: groupFolder });
      logger.debug(
        { groupFolder, responseCount: buffer.length },
        'Memory write-back completed',
      );
    } catch (err) {
      logger.warn({ err, groupFolder }, 'Memory write-back failed');
    }
  }
}
