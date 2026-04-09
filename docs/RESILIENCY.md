# DevenClaw Resiliency & Disaster Recovery

*Last audited: 2026-04-07*

## What Survives Mac Death (Cloud-backed)

| Data | Location | Notes |
|------|----------|-------|
| Chat messages & history | Turso DB (AWS Mumbai) | All messages persisted |
| Agent group configs | Turso DB (`registered_groups`) | JID, trigger, model, MCP servers, work_dir |
| Scheduled tasks & run logs | Turso DB | Prompts, schedules, execution history |
| Todos & reminders | Turso DB | Including recurrence, remind_at |
| Email rules & logs | Turso DB | Routing rules and audit trail |
| Dashboard tokens | Turso DB | Auth, roles, reminder routing |
| Push subscriptions | Turso DB | Browser push endpoints |
| Token usage tracking | Turso DB | Per-group cost data |
| All source code | GitHub (`venksuper88/nanoclaw`) | Full platform code |
| Agent CLAUDE.md files (8 groups) | Git-tracked in `groups/` | Agent personas and instructions |

## What's LOST if Mac Dies (Local-only)

| Data | Size | Risk | Notes |
|------|------|------|-------|
| `.env` secrets | 4 KB | 🔴 CRITICAL | Turso token, OAuth, Telegram bot token, Gemini key, VAPID keys — nothing works without this |
| Agent session state | ~515 MB | 🟡 MEDIUM | Agents restart fresh, lose conversation context. Messages survive in Turso |
| mem0 memory vectors | Unknown | 🔴 HIGH | All semantic memory embeddings — Ollama + mem0 is 100% local |
| Attachments | ~30 MB | 🟡 MEDIUM | User-uploaded files (screenshots, docs) |
| Frontend builds | ~47 MB | 🟢 LOW | Rebuilt from source: `npm run build` |
| LaunchAgent plist | 1 file | 🟢 LOW | Recreated during `/setup` |
| `~/.claude/` state | ~329 MB | 🟡 MEDIUM | Claude Code sessions, project configs, skills |
| IPC queues | ~33 MB | 🟢 LOW | Ephemeral — only in-flight messages lost |
| External project agent configs | Varies | 🟡 MEDIUM | e.g. `RailMasterPlayables/.agents/` — may not be in nanoclaw git |

## Known Architectural Risks

### 1. `.env` — Single Point of Failure
All API keys and tokens live in one local file. No backup, no vault, no cloud sync.

### 2. mem0 Memory — Completely Local
Ollama runs locally. All semantic memory embeddings have zero cloud backup. This is the biggest data loss risk.

### 3. Agent work_dir Inside Git Repos
Agents with `work_dir` inside a git repo (e.g. `.agents/playables/` in RailMasterPlayables) break when branches switch — the directory gets deleted by git, corrupting the tmux session's CWD.

**Mitigation:** Add `.agents/` to `.gitignore` in affected repos. Platform should validate work_dir exists before each prompt.

### 4. No Automated Backups
No crontab, no backup scripts, no periodic cloud sync. Zero redundancy.

### 5. Session State Not Persisted to Cloud
Agent session IDs are in Turso, but the actual Claude conversation state (~515 MB in `data/sessions/`) is local-only.

## Backup Strategy (TODO)

### Tier 1 — Immediate (do today)
- [ ] Back up `.env` to a password manager or encrypted cloud note
- [ ] Push any uncommitted CLAUDE.md changes to git
- [ ] Add `.agents/` to `.gitignore` in external repos

### Tier 2 — This Week
- [ ] Automated `.env` + secrets backup to encrypted cloud storage
- [ ] mem0 text content export to Turso (`memory_backup` table) on a cron
- [ ] rsync attachments to iCloud Drive or cloud bucket

### Tier 3 — Architectural
- [ ] Move mem0 to a cloud vector DB (Qdrant Cloud, Pinecone) — memories survive Mac death
- [ ] Enable Time Machine for full Mac state backup
- [ ] work_dir validation + auto-recovery in `tmux-runner.ts`
- [ ] Session health detection (detect `getcwd` errors, auto-recreate)

## External Services Inventory

| Service | Purpose | Credential Location | Cloud Data? |
|---------|---------|-------------------|-------------|
| Turso | Primary database | `.env` TURSO_DATABASE_URL, TURSO_AUTH_TOKEN | Yes |
| Claude (Anthropic) | Agent LLM | `.env` CLAUDE_CODE_OAUTH_TOKEN | Stateless |
| Telegram | Channel | `.env` TELEGRAM_BOT_TOKEN | Messages on Telegram servers |
| Gemini | Content extraction | `.env` GEMINI_API_KEY | Stateless |
| Ollama | Local LLM + embeddings | Runs locally, no token | No — local only |
| VAPID (Web Push) | Push notifications | `.env` VAPID keys | Subscriptions in Turso |
| GitHub | Source control | SSH keys / HTTPS auth | Full code mirror |
