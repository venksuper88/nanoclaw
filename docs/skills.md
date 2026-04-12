# Skills

## Sync Mechanism (`setupClaudeConfig` in `src/tmux-runner.ts`)

Skills are synced from three sources (in priority order) into `.claude/skills/`:

1. **Group-specific** — `groups/{folder}/.claude/skills/`
2. **Container-wide** — `container/skills/`
3. **Global user** — `~/.claude/skills/`

If `allowedSkills` is set (non-empty array), only those skill folders sync. Synced skills marked with `.devenclaw` marker. Cleanup removes skills no longer synced.

## Skill Types

| Type | Description | Example |
|------|-------------|---------|
| Feature | Merge a `skill/*` branch to add capabilities | `/add-telegram`, `/add-slack` |
| Utility | Ship code files alongside SKILL.md | `/claw` |
| Operational | Instruction-only workflows, always on `main` | `/setup`, `/debug` |
| Container | Loaded inside agent sessions at runtime | `container/skills/` |

## Container Skills (`container/skills/`)

Currently installed: agent-browser, applovin, capabilities, clean-attachments, document-vault, notes, pdf-reader, restart, slack-formatting, status, tenjin.

## Per-Group Skill Control

- `allowedSkills: string[]` on registered_groups controls which skill folders load
- Empty array = all skills load
- Non-empty array = only listed skill folders sync
- Enforced by `syncSkillsFrom()` filtering during tmux session setup

## Key Behaviors

- Skills sync every turn via `setupClaudeConfig` — no restart needed
- Container skills take precedence over global skills with the same name
- MCP tools (unlike skills) are negotiated once at session start — new tools require `/new` session
