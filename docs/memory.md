# Memory (mem0)

## Architecture (`src/memory.ts`)

Semantic memory powered by mem0ai/oss + Ollama for fact extraction and embedding.

## Inject-Once

Per-group session tracking via `sessions: Map<groupFolder, Set<memoryIds>>`. Each memory is injected only once per session — subsequent messages skip already-loaded memories.

## Scope Filtering & User Isolation

### Private Pool
- Each group's memories stored under `memoryUserId` (default: 'venky', configurable per group)
- Supports comma-separated multi-user IDs

### Shared Pool
- Memories stored under userId `'shared'` with scope tags in metadata
- Owner groups see all shared scopes
- Non-owners filtered by `memoryScopes` whitelist on the group config
- `matchesSharedScopes()` enforces scope tag matching

## Memory Modes

| Mode | Behavior |
|------|----------|
| `full` | mem0 shared + private memory, scope-filtered |
| `local` | CLAUDE.md only, no mem0 |
| `disabled` | No memory injection |

## Write-Back

Conversation accumulates in `conversationBuffers` during session. At session end:
1. `writeBack()` calls `mem0.add()` to extract facts from conversation
2. Max 4000 chars, truncated intelligently
3. Writes only to private pool under group's `memoryUserId`
4. Never auto-writes to shared pool

## Infrastructure

- **LLM provider**: Ollama (for fact extraction)
- **Embedder**: Ollama
- **Vector store**: In-memory
- Degrades gracefully if Ollama unavailable (`MEMORY_ENABLED=false` disables)
