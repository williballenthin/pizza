# Session Metadata Redesign (Issue #10)

## Problem

The session metadata card shows confusing message categories. "Messages" displays
`X user, Y assistant, Z tool` alongside a separate "Tool Calls" row. The relationship
between assistant messages, tool results, and tool calls is unclear. The "Persisted"
count adds to the confusion.

## Requirements

1. Three clear message categories: **user**, **assistant** (text responses), **tool calls**
2. **History size**: total messages + total tokens across the full session
3. **Context window**: messages currently in context + token usage as percentage of max

## Design

### Shared types

Replace `messageCount: number` on `SessionMeta` with:

```typescript
export interface SessionMessageStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
}
```

Update `StateMessage` similarly: replace `messageCount?: number` with
`messageStats?: SessionMessageStats`.

### Server: JSONL parsing (`session-manager.ts`)

Expand `parseSessionFile` to count per-role stats during its single pass over lines:
- `userMessages`: entries where `message.role === "user"`
- `assistantMessages`: entries where `message.role === "assistant"`
- `toolCalls`: count of `tool_use`/`toolCall` content blocks within assistant messages
- `totalMessages`: total `type: "message"` entries (the existing count)

Update `ParsedSessionFile` to carry `messageStats` instead of `messageCount`.

### Server: WebSocket state (`ws-handler.ts`)

Pass `messageStats` through in the state message instead of `messageCount`.

### Client: session runtime (`session-runtime.ts`)

Store `messageStats` from state message instead of raw `messageCount`.

### Client: info stack (`render-session-info-stack.ts`)

Replace the current stats display with three rows:

| Row | Content |
|-----|---------|
| Messages | `X user · Y assistant · Z tool calls` |
| History | `N messages · Xk tokens` |
| Context | `N messages · X% of Yk` |

Remove the old "Tool Calls" and "Persisted" rows.

Accept `usage: UsageTotals` and `currentContextWindow: number | null` as new props
to compute history tokens and context percentage.

### Client: chat-view stats (`chat-view.ts`)

Simplify `SessionStats` to three fields: `userMessages`, `assistantMessages`,
`toolCalls`. Remove `toolResults` and `totalVisible`.

### Client: session list (`session-list.ts`)

Update to use `messageStats.totalMessages` instead of `messageCount`.

### Testing

- New `tests/unit/session-stats.test.ts`: unit tests for stats computation
  (extracted to a shared utility for both server parsing and client rendering)
- Update `tests/api/sessions.test.ts`: verify `messageStats` shape in API responses

## Metadata card layout (after)

```
Session       abc12345-...
Created       Feb 19, 2026 3:45 PM
Last Activity 2 minutes ago
Model         claude-sonnet-4-20250514
Thinking      medium
Messages      12 user · 14 assistant · 23 tool calls
History       49 messages · 125k tokens
Context       32 messages · 68.2% of 200k
```
