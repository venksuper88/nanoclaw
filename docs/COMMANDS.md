# Commands

Commands are scripts that run without an LLM. They have a standard interface, execute as child processes, and can do anything: call APIs, query databases, invoke Google Gemini, process files. The orchestrator provides the runtime environment and messaging — you provide the logic.

## When to use commands vs skills

| | Skills | Commands |
|---|---|---|
| **Runs via** | LLM (Claude) | Script (Node/Bash/Python) |
| **Best for** | Conversations, judgment calls, open-ended tasks | Deterministic workflows, API calls, data processing |
| **Token cost** | 25K+ per invocation | Zero |
| **Latency** | 5-30s | <1s typically |
| **Example** | "Summarize this thread" | "Log this transaction to the P&L" |

Use commands when the logic is deterministic and doesn't need reasoning. Use skills when you need the LLM to interpret, decide, or generate.

## Creating a command

### 1. Directory structure

Commands live in a `commands/` folder. Two scopes:

```
groups/{your-folder}/commands/{name}/    # Local to your group (takes precedence)
container/commands/{name}/               # Global (available to all groups)
```

Each command is a folder containing:

```
commands/process-txn/
  COMMAND.json    # Metadata (required)
  run.mjs         # Entry point (or run.sh, run.py)
```

### 2. COMMAND.json

```json
{
  "name": "process-txn",
  "description": "Process a bank transaction from email extraction",
  "runtime": "node",
  "entry": "run.mjs"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Command name (used in `!name` autocomplete and MCP tool) |
| `description` | Yes | Short description shown in autocomplete and `list_commands` |
| `runtime` | No | `node`, `bash`, or `python`. Auto-detected from entry file extension if omitted |
| `entry` | No | Entry point filename. Default: `run.mjs` |

### 3. Entry point script

Your script receives JSON on **stdin** and writes JSON (or plain text) to **stdout**.

**Node.js example (`run.mjs`):**

```javascript
import { readFileSync } from 'fs';

// Read JSON input from stdin
const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));

// Your logic here
const result = {
  message: `Processed transaction from ${input.from}`,
  data: { amount: 7000, category: 'household' }
};

// Write JSON output to stdout
process.stdout.write(JSON.stringify(result));
```

**Bash example (`run.sh`):**

```bash
#!/bin/bash
INPUT=$(cat)
SENDER=$(echo "$INPUT" | jq -r '.from')
echo "{\"message\": \"Processed email from $SENDER\"}"
```

**Python example (`run.py`):**

```python
import sys, json

input_data = json.load(sys.stdin)
result = {"message": f"Processed: {input_data.get('subject', 'unknown')}"}
json.dump(result, sys.stdout)
```

## Interface

### Input (stdin)

JSON object. The schema depends on who invokes the command:

**From email rules:**
```json
{
  "from": "sender@example.com",
  "fromName": "Sender Name",
  "subject": "Email subject",
  "body": "Full email body text",
  "summary": "Gemini-extracted summary",
  "threadId": "gmail-thread-id",
  "messageId": "gmail-message-id"
}
```

**From dashboard (`!command args`):**
```json
{
  "args": "the text after the command name",
  "sender": "Venky"
}
```

**From MCP tool (agent invocation):**
```json
{
  "any": "fields the agent passes"
}
```

### Output (stdout)

JSON object with optional fields:

```json
{
  "message": "Human-readable result sent to the group chat",
  "data": { "any": "structured data for the caller" }
}
```

If stdout is plain text (not JSON), it's sent as-is to the group chat.

If the command fails (non-zero exit code), stderr is captured and sent as an error message.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success — stdout sent to chat |
| Non-zero | Error — stderr sent as error message |
| 124 | Timeout (killed by orchestrator after 60s default) |

## Environment variables

The orchestrator sets these for every command:

| Variable | Example | Description |
|----------|---------|-------------|
| `NANOCLAW_GROUP_FOLDER` | `dashboard_devenacc` | Owning group's folder name |
| `NANOCLAW_CHAT_JID` | `dash:devenacc` | Group's chat JID |
| `NANOCLAW_COMMAND_NAME` | `process-txn` | Name of the running command |

Plus all parent process env vars (PATH, HOME, etc.).

## Lifecycle messages

The orchestrator automatically sends messages to the group chat:

1. **Start**: `"Running command: {name}"`
2. **Success**: The command's stdout `message` (or `"Command completed: {name}"`)
3. **Error**: `"Command failed: {name} — {stderr}"`
4. **Timeout**: `"Command failed: {name} — timed out"`

## Invoking commands

### From the dashboard

Type `!` in the chat input to see available commands. Select one or type `!command-name args`.

### From an agent (MCP)

Agents can use the `run_command` MCP tool:

```
Tool: run_command
  command_name: "process-txn"
  input: { "amount": 7000, "category": "personal" }
```

Use `list_commands` to see what's available.

### From email rules

In Settings > Email Routing Rules, set:
- **Action**: Command
- **Command name**: The command to invoke
- **Target group**: The group that owns the command

The full email extraction JSON is passed as input.

## Scoping and precedence

Local commands (in `groups/{folder}/commands/`) override global commands (in `container/commands/`) with the same name. This lets groups customize behavior while sharing a common base.

A group only sees:
- Its own local commands
- All global commands (not overridden by local ones)

## Tips

- **Keep commands fast.** Default timeout is 60 seconds. If you need longer, the orchestrator supports custom timeouts but commands should be snappy.
- **Use stderr for errors.** Write diagnostic info to stderr — it's captured and sent to the chat on failure.
- **Commands run in parallel.** Each invocation spawns a separate process. Don't assume exclusive access to shared resources.
- **The working directory is the command folder.** Use relative paths for bundled data files, absolute paths for group/project files.
- **Test locally first.** You can run a command directly: `echo '{"test": true}' | node groups/your-group/commands/your-cmd/run.mjs`
