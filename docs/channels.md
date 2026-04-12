# Channels

## Self-Registration Pattern (`src/channels/registry.ts`)

Channels use a factory pattern. Each channel file calls `registerChannel(name, factory)` to self-register at startup. The factory receives `ChannelOpts` with callbacks (`onMessage`, `onChatMetadata`) and registered groups, returns a Channel instance or null if credentials are missing.

## Available Channels

Located in `src/channels/`:

| Channel | File | Notes |
|---------|------|-------|
| Gmail | `gmail.ts` | Email input with OAuth2 |
| Telegram | `telegram.ts` | Bot API |
| Slack | — | Available via feature skill |
| Discord | — | Available via feature skill |
| WhatsApp | — | Available via feature skill |

## Message Flow

```
Channel receives inbound message
  -> onMessage callback
  -> Router processes (find registered group, extract attachments)
  -> Orchestrator queues via GroupQueue
  -> Agent runs in tmux session
  -> Agent produces output via MCP send_message
  -> IPC watcher picks up response
  -> channel.sendMessage() routes back to original chat
```

## Channel Interface

Each channel implements:
- `sendMessage(jid, text, options?)` — send outbound message
- `sendFile(jid, filePath, caption?)` — send file attachment
- Event callbacks for inbound messages
