# Settings

## Frontend (`web/src/components/SettingsView.tsx`)

Four sections (owner-only except Memory):

### 1. Groups
Per-group expandable configuration panel. Configurable fields:

| Field | Type | Purpose |
|-------|------|---------|
| `memoryMode` | `full \| local \| disabled` | Memory strategy (full=shared mem0, local=group-only, disabled) |
| `memoryScopes` | `string[]` | Scoped memory access tags |
| `memoryUserId` | `string` | User owning private memories (default: 'venky') |
| `isTransient` | `boolean` | Auto-close agent after inactivity |
| `showInSidebar` | `boolean` | Visibility in dashboard sidebar |
| `idleTimeoutMinutes` | `number \| null` | Agent idle timeout (null = default 30min) |
| `allowedSkills` | `string[]` | Whitelisted skills (empty = all) |
| `allowedMcpServers` | `string[]` | Whitelisted MCP servers |
| `disabledTools` | `string[]` | Blacklisted MCP tools |
| `model` | `string` | Claude model (opus/sonnet) |
| `contextWindow` | `string` | Context size (200k/1m) |
| `mode` | `tmux` | Execution mode |
| `requiresTrigger` | `boolean` | Require @mention trigger |
| `workDir` | `string` | Custom working directory |

### 2. Email
Email routing rules and extraction statistics.

### 3. Access
Dashboard token management:
- Create/revoke tokens with name, role, allowed groups
- Set reminder group per token
- Non-owner tokens show masked (first 8 chars)

### 4. Memory
Mem0 stats, shared memory management, scoped memory definitions.

## API Routes

- `GET /api/groups/:jid/settings` — retrieve group settings (owner only)
- `PUT /api/groups/:jid/settings` — update group settings (owner only)
- `GET /api/tokens` — list all tokens (owner only)
- `POST /api/tokens` — create token (owner only)
- `DELETE /api/tokens/:token` — revoke token (owner only)
- `PUT /api/tokens/:token/reminder-group` — set reminder group (owner only)
