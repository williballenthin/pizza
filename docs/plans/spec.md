# Pi Web UI — Behavioral Specification

A self-hosted web interface for the [pi coding agent](https://github.com/badlogic/pi-mono), providing browser-based access to a server-side agent with full tool execution capabilities (file system, bash, etc.).

## 1. Overview

Pi Web UI is a lightweight, self-hosted web application that exposes the pi coding agent through a responsive browser interface. It is designed to run on a personal server behind Tailscale (or similar VPN), accessed primarily from a mobile device but also from desktop browsers. No authentication is required — network-level access control is assumed.

The application consists of two parts:

- **Server**: A Node.js process that manages pi agent subprocesses (via RPC mode), provides a REST API for session management, a WebSocket API for real-time agent interaction, and serves the static frontend.
- **Client**: A responsive web application built with lit web components that displays the chat interface, session list, and settings controls.

The server runs the pi agent in `--mode rpc`, communicating via newline-delimited JSON over stdin/stdout. The browser never communicates with LLM providers directly — all agent execution happens server-side.

---

## 2. Deployment Context

- Runs in Docker with a bind mount for host filesystem access.
- Long-running server process.
- Single-user (or small trusted group) behind Tailscale — no authentication layer.
- LLM provider API keys are configured server-side via environment variables.
- Session data persists to a configurable directory (bind-mounted volume).

### Configuration

| Source | Variable | Description |
|--------|----------|-------------|
| Env | `PI_SESSION_DIR` | Directory for session persistence. Default: `~/.pi/agent/sessions` |
| Env | `PI_PORT` | HTTP/WebSocket server port. Default: `3000` |
| Env | `PI_DEFAULT_MODEL` | Default model identifier (e.g., `openrouter/google/glm-4.7-flash`). |
| Env | `PI_DEFAULT_THINKING_LEVEL` | Default thinking level. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Default: `off` |
| Env | Provider-specific keys | `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. Passed through to pi agent subprocess. |
| CLI | `--session-dir <path>` | Overrides `PI_SESSION_DIR`. |
| CLI | `--port <number>` | Overrides `PI_PORT`. |

CLI arguments take precedence over environment variables.

---

## 3. Session Model

A **session** is a single conversation thread with the pi agent. Each session maps to one pi RPC subprocess on the server.

### Session Lifecycle

1. **Created**: User starts a new session from the landing page. Server spawns a `pi --mode rpc` subprocess.
2. **Active**: User sends messages, agent responds, tools execute. Events stream in real time.
3. **Idle**: User navigates away or closes the tab. The RPC subprocess remains alive for a configurable idle timeout (default: 5 minutes), then is terminated gracefully.
4. **Persisted**: Session data lives on disk in `PI_SESSION_DIR` as JSONL files (managed by pi). Sessions persist across server restarts.
5. **Resumed**: User opens a previously persisted session. Server spawns a new RPC subprocess attached to the existing session data.

### Session Metadata

Each session has the following metadata, derived from the session's persisted data:

| Field | Description |
|-------|-------------|
| `id` | Unique session identifier (from pi). |
| `name` | Auto-generated from the first user message (truncated to ~60 characters). Editable by the user. |
| `createdAt` | Timestamp of session creation. |
| `lastActivityAt` | Timestamp of the most recent message. Used for default sort order (descending). |
| `messageCount` | Total number of messages in the session. |

### Concurrent Sessions

Multiple sessions may be open simultaneously (e.g., in different browser tabs). Each active session has its own RPC subprocess. The server manages the process pool and enforces the idle timeout independently per session.

---

## 4. Landing Page

**Route**: `/`

The landing page is the entry point. It shows all sessions and provides the ability to create new ones.

### Layout

```
┌─────────────────────────────────────┐
│  Pi Web UI                  [+ New] │
├─────────────────────────────────────┤
│                                     │
│  Session Name                       │
│  12 messages · 2 hours ago          │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  Another Session                    │
│  48 messages · yesterday            │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  Older Session                      │
│  3 messages · 3 days ago            │
│                                     │
│  ...                                │
└─────────────────────────────────────┘
```

### Behavior

- Sessions are listed sorted by `lastActivityAt` descending (most recent first).
- Each session entry shows: **name** (bold), **message count**, and **relative time** since last activity (e.g., "2 hours ago", "yesterday", "Jan 15").
- Tapping/clicking a session navigates to that session's chat view.
- The **[+ New]** button creates a new session and navigates directly to its chat view.
- The list loads on page load via REST API. No pagination initially — all sessions are listed. If performance becomes an issue, virtual scrolling can be added later.
- A session entry can be **long-pressed (mobile) or right-clicked (desktop)** to reveal a context menu with: **Rename**, **Delete**.
  - **Rename**: Inline text editing of the session name.
  - **Delete**: Confirmation prompt, then removes the session from disk and the list.

---

## 5. Chat View

**Route**: `/session/:id`

The chat view is the primary interaction surface. It shows the conversation history and allows the user to send messages to the agent.

### Layout — Mobile (< 768px)

```
┌─────────────────────────────────────┐
│  [←]  Session Name          [gear]  │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │ User message                │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ Assistant response with     │    │
│  │ markdown, code blocks, etc. │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ ▶ Tool: bash                │    │
│  │   ls -la /home/user         │    │
│  │   ─────────────────────     │    │
│  │   drwxr-xr-x user ...      │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ Assistant continuation...   │    │
│  └─────────────────────────────┘    │
│                                     │
├─────────────────────────────────────┤
│  [Type a message...]       [Send ▶] │
└─────────────────────────────────────┘
```

### Layout — Desktop (>= 768px)

Same single-column layout but wider, with more horizontal space for code blocks and tool output. The message column is centered with a max-width of ~800px. The input area stretches to the column width.

### Header Bar

- **Back arrow** `[←]`: Navigates to the landing page (`/`).
- **Session name**: Displayed in the center. Tapping opens inline rename.
- **Settings gear** `[gear]`: Opens the settings panel (see Section 6).

### Message Display

Messages are rendered in chronological order, scrolling vertically. The view auto-scrolls to the bottom when new content arrives, unless the user has manually scrolled up.

#### User Messages

- Displayed right-aligned (or full-width with a distinct background) to visually distinguish from assistant messages.
- Plain text. Markdown is not rendered in user messages.

#### Assistant Messages

- Displayed left-aligned (or full-width with a different background).
- Content is rendered as markdown:
  - Headings, bold, italic, lists, links.
  - Fenced code blocks with syntax highlighting and a **copy** button.
  - Inline code.
- During streaming, text appears incrementally (token by token). A blinking cursor or typing indicator shows that the response is still arriving.

#### Thinking Blocks

- When the agent uses extended thinking (thinking level > off), thinking content is displayed in a **collapsible block** above the assistant's response text.
- Collapsed by default, showing a summary line like "Thinking... (click to expand)".
- Expanded view shows the raw thinking text in a muted/italic style.

#### Tool Calls (Inline)

Tool executions are displayed inline in the conversation flow, between the assistant text that triggered them and the continuation.

Each tool call block shows:

- **Tool name** as a header (e.g., "bash", "read", "write", "edit").
- **Collapsible**: Collapsed by default, showing just the tool name and a one-line summary (e.g., the command for bash, the file path for read/write/edit).
- **Expanded view**:
  - **Input**: The arguments passed to the tool (formatted appropriately — command text for bash, file path + content for write, etc.).
  - **Output/Result**: The tool's output, rendered as preformatted text. Long outputs are truncated with a "show more" toggle.
- **Status indicator**: Spinner while executing, checkmark when complete, X on error.

#### Streaming Behavior

- Text tokens stream in real-time as they arrive from the server.
- Tool calls appear as soon as the agent emits them. The tool block shows a spinner until the result arrives.
- If the agent makes multiple tool calls in parallel, they appear as sequential blocks, each with its own spinner/result.

### Input Area

- **Text input**: A multi-line text area, bottom-anchored.
  - On mobile: Single line by default, expands as the user types (up to ~4 visible lines), then scrolls internally.
  - On desktop: Can be taller by default (2-3 lines), with the same expansion behavior.
  - **Enter** sends the message (on desktop). **Shift+Enter** inserts a newline.
  - On mobile, the virtual keyboard's "Send" / "Return" action sends the message.
- **Send button**: To the right of the input area. Visually prominent. Disabled when the input is empty.
- **Draft persistence**: Draft text is persisted per-session in browser storage and restored after tab discard/reload. Sending a message clears the persisted draft for that session.
- **Slash command autocomplete**: While the first token starts with `/` and has no arguments yet, the client shows a command suggestion popup anchored to the composer. The popup must render above the message list so entries remain visible and clickable.
- **Stop button**: While the agent is streaming, the Send button transforms into a **Stop** button (e.g., square icon). Tapping it sends an abort command to the agent, stopping the current response.

### Steer / Interrupt Behavior

- If the user types and sends a message while the agent is actively streaming, the message is sent as a **steer** command — it interrupts the agent's current work and delivers the new message immediately.
- The UI should visually indicate that the agent was interrupted (e.g., the interrupted response shows an "interrupted" badge or is visually truncated).

### Navigation

- The browser URL updates to `/session/:id` so that refreshing the page re-opens the same session.
- The back button (browser or header `[←]`) returns to the landing page.

### Message History Sidebar

- The chat view includes a message history sidebar with search and role filters.
- Filter options are `User`, `No-tools`, and `All`.
- Default filter is `User` to reduce sidebar entry count and focus navigation on user turns.

### Git Sidebar Panel

- The sidebar is ordered as: message history controls/list at the top, Git panel beneath it, and active sessions at the bottom.
- The panel shows current branch and HEAD short SHA for the session's project directory.
- The panel shows a single "Recent commits" list (maximum 16 commits) with a synthetic first entry `[current index]` that has no commit hash.
- Selecting `[current index]` shows staged and unstaged files.
- Selecting a commit entry shows files changed in that commit.
- File entries include status markers with color coding:
  - Added (`A`) is green.
  - Modified/renamed/conflict/untracked (`M`, `R`, `U`, `?`) is yellow.
  - Deleted (`D`) is red.
- Clicking any file entry opens a diff modal with the patch for that file in the active scope (staged, unstaged, or commit).
- Git metadata refreshes automatically every 5 seconds and also refreshes when session activity updates are received.
- If the session directory is not a Git repository, the panel shows a "Not a git repository" state.

---

## 6. Settings Panel

The settings panel is accessible via the gear icon in the chat view header. It slides in as an overlay on mobile (from the right) or appears as a dropdown/modal on desktop.

### Settings

| Setting | Control | Description |
|---------|---------|-------------|
| Model | Dropdown/select | Choose from available models. The list is populated by querying the active RPC subprocess (`get_available_models` command), then filtered by the server using global pi settings `enabledModels` (`~/.pi/agent/settings.json` or `PI_CODING_AGENT_DIR`). `enabledModels` entries are treated as exact `provider/modelId` strings. If the setting is missing/empty/invalid, all available models are shown. |
| Thinking Level | Segmented control or dropdown | Values: Off, Minimal, Low, Medium, High, XHigh. Changes take effect on the next message. |
| Theme | Toggle | Auto (system), Light, Dark. Persisted in browser localStorage. |

### Behavior

- Changing the **model** sends a `set_model` command to the RPC subprocess. The change applies immediately to the current session.
- Changing the **thinking level** sends a `set_thinking_level` command. The change applies to the next agent turn.
- The settings panel shows the **current** values as reported by the agent state (`get_state` command).
- Settings changes are per-session. Different sessions can use different models/thinking levels.

---

## 7. Server API

### REST Endpoints

All REST endpoints are prefixed with `/api`.

#### `GET /api/sessions`

Returns a list of all sessions with metadata.

**Response** `200 OK`:
```json
{
  "sessions": [
    {
      "id": "abc123",
      "name": "Debug authentication flow",
      "createdAt": "2025-06-15T10:30:00Z",
      "lastActivityAt": "2025-06-15T12:45:00Z",
      "messageCount": 24
    }
  ]
}
```

Sessions are returned sorted by `lastActivityAt` descending.

#### `POST /api/sessions`

Creates a new session. Returns the session ID.

**Response** `201 Created`:
```json
{
  "id": "def456"
}
```

#### `PATCH /api/sessions/:id`

Updates session metadata (currently only `name`).

**Request**:
```json
{
  "name": "New session name"
}
```

**Response** `200 OK`:
```json
{
  "id": "def456",
  "name": "New session name"
}
```

#### `DELETE /api/sessions/:id`

Deletes a session. Terminates the RPC subprocess if active. Removes session data from disk.

**Response** `204 No Content`.

#### `GET /api/health`

Health check endpoint.

**Response** `200 OK`:
```json
{
  "status": "ok",
  "activeSessions": 2
}
```

#### `GET /api/projects`

Returns discovered project roots from the sessions store.

**Response** `200 OK`:
```json
{
  "projects": [
    {
      "cwd": "/home/user/code/my-pi-web",
      "displayPath": "~/code/my-pi-web",
      "sessionCount": 12,
      "lastActivityAt": "2026-02-23T08:00:00Z"
    }
  ]
}
```

#### `GET /api/sessions/:id/git/status`

Returns Git working tree status for the session's project.

**Response** `200 OK`:
```json
{
  "isRepo": true,
  "branch": "main",
  "head": "4a7f...",
  "staged": [{ "status": "M", "path": "src/file.ts" }],
  "unstaged": [{ "status": "?", "path": "scratch.txt" }]
}
```

#### `GET /api/sessions/:id/git/commits?limit=16`

Returns recent commits for the session's project.

#### `GET /api/sessions/:id/git/commits/:sha/files`

Returns file-level status for the specified commit.

#### `GET /api/sessions/:id/git/diff?scope=staged|unstaged|commit&path=<file>&sha=<commit>`

Returns a textual diff for a selected file and scope.

### WebSocket Protocol

**Endpoint**: `/api/sessions/:id/ws`

The WebSocket connection is the primary communication channel for a session. Opening a WebSocket connection to a session causes the server to spawn (or reattach to) an RPC subprocess for that session.

#### Client → Server Messages

All messages are JSON objects with a `type` field.

##### `prompt`

Send a user message to the agent.

```json
{
  "type": "prompt",
  "text": "Please list the files in /home/user"
}
```

##### `steer`

Interrupt the agent with a new message (sent while agent is streaming).

```json
{
  "type": "steer",
  "text": "Actually, stop that and do this instead"
}
```

##### `abort`

Stop the agent's current operation.

```json
{
  "type": "abort"
}
```

##### `get_state`

Request current agent state.

```json
{
  "type": "get_state"
}
```

##### `set_model`

Change the model.

```json
{
  "type": "set_model",
  "provider": "openrouter",
  "model": "google/glm-4.7-flash"
}
```

##### `set_thinking_level`

Change the thinking level.

```json
{
  "type": "set_thinking_level",
  "level": "medium"
}
```

##### `get_available_models`

Request the list of available models.

```json
{
  "type": "get_available_models"
}
```

#### Server → Client Messages

All messages are JSON objects with a `type` field.

##### `state`

Response to `get_state`. Also sent when the WebSocket first connects (initial state).

```json
{
  "type": "state",
  "model": { "provider": "openrouter", "id": "google/glm-4.7-flash" },
  "thinkingLevel": "off",
  "isStreaming": false,
  "messages": [ ... ]
}
```

The `messages` array contains the full conversation history. Each message follows the pi `AgentMessage` format (user, assistant, toolResult roles).

##### `agent_event`

A real-time event from the agent. The `event` field contains the pi `AgentEvent` structure.

```json
{
  "type": "agent_event",
  "event": {
    "type": "message_update",
    "assistantMessageEvent": {
      "type": "text_delta",
      "delta": "Here are the"
    }
  }
}
```

Event subtypes relayed from the agent:
- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

##### `available_models`

Response to `get_available_models`. The server may filter the RPC result using global pi `enabledModels` (exact `provider/modelId` entries) before sending this message to the client.

```json
{
  "type": "available_models",
  "models": [
    { "provider": "openrouter", "id": "google/glm-4.7-flash", "label": "GLM 4.7 Flash" },
    { "provider": "anthropic", "id": "claude-sonnet-4-20250514", "label": "Claude Sonnet 4" }
  ]
}
```

##### `error`

An error occurred.

```json
{
  "type": "error",
  "message": "RPC subprocess crashed unexpectedly"
}
```

#### Connection Lifecycle

1. Client opens WebSocket to `/api/sessions/:id/ws`.
2. Server spawns (or reattaches to) RPC subprocess for session `:id`.
3. Server sends `state` message with current conversation history and settings.
4. Client renders the conversation and is ready for interaction.
5. Client sends `prompt`, `steer`, `abort`, or state query messages.
6. Server relays commands to RPC subprocess stdin and streams events back.
7. On WebSocket close: server starts idle timeout for the RPC subprocess.
8. On idle timeout expiry: server terminates the RPC subprocess. Session data remains on disk.
9. On WebSocket reconnect (same session): server re-spawns RPC subprocess, sends fresh `state`.

---

## 8. Theming

The application supports three theme modes: **Auto** (follows system preference), **Light**, and **Dark**.

- Theme preference is stored in browser `localStorage`.
- The `prefers-color-scheme` media query drives the Auto mode.
- CSS custom properties control all theme-dependent colors.
- The color palette should be minimal and functional — no heavy branding. Neutral grays for backgrounds, clear contrast for text, subtle accent color for interactive elements.

### Color Roles

| Role | Description |
|------|-------------|
| Background | Page background |
| Surface | Card/message bubble background |
| Surface Alt | Alternate surface (e.g., user message bubbles) |
| Text Primary | Main text color |
| Text Secondary | Muted text (timestamps, metadata) |
| Border | Subtle dividers and borders |
| Accent | Interactive elements (buttons, links) |
| Code Background | Code block background |
| Error | Error text/indicators |

---

## 9. Responsive Design Details

### Breakpoints

| Breakpoint | Width | Label |
|------------|-------|-------|
| Mobile | < 768px | Primary target |
| Desktop | >= 768px | Secondary target |

### Mobile-Specific Behaviors

- **Input area** is bottom-anchored and stays above the virtual keyboard when focused.
- **Settings panel** slides in from the right as a full-height overlay.
- **Session context menu** triggered by long-press on a session entry.
- **Message bubbles** span nearly full width with small horizontal padding.
- **Code blocks** are horizontally scrollable.
- **Touch targets** are at least 44x44px per accessibility guidelines.

### Desktop-Specific Behaviors

- **Message column** is centered with `max-width: 800px`.
- **Settings panel** appears as a dropdown or small modal anchored to the gear icon.
- **Session context menu** triggered by right-click.
- **Input area** supports `Enter` to send, `Shift+Enter` for newline.

---

## 10. Component Reuse from pi-web-ui

The `@mariozechner/pi-web-ui` package provides lit-based web components. The following components are candidates for reuse:

### Reusable (data-driven, no Agent coupling)

- **MessageList**: Accepts `messages: AgentMessage[]`, `tools: AgentTool[]`, `pendingToolCalls: Set<string>`, `isStreaming: boolean`. Renders the conversation. This is the primary rendering workhorse.
- **AssistantMessage**, **UserMessage**, **ToolMessage**: Individual message renderers.
- **Markdown/code rendering utilities**: Syntax highlighting, copy buttons, etc.

### Not Reusable (tightly coupled to browser-side Agent)

- **ChatPanel**: Requires a direct `Agent` instance. Manages the full chat lifecycle internally.
- **AgentInterface**: Typed to `Agent`, calls `agent.prompt()`, `agent.abort()`, etc. directly.
- **AppStorage / IndexedDB stores**: We use server-side session storage, not IndexedDB.

### Integration Strategy

Build a custom `ChatView` component that:
1. Manages WebSocket communication with the server.
2. Maintains a local message array updated from server events.
3. Passes the message array to pi-web-ui's `MessageList` for rendering.
4. Provides its own input area and controls.

This approach reuses the rendering layer (the hardest part to build well — markdown, code highlighting, tool display) while providing our own communication and layout layer.

---

## 11. Error Handling

### Connection Errors

- If the WebSocket connection drops, the UI shows a non-intrusive banner: "Connection lost. Reconnecting..." with automatic reconnection (exponential backoff: 1s, 2s, 4s, 8s, max 30s).
- On chat view startup, if a cached snapshot exists for the session, the UI renders the cached messages immediately in a muted read-only mode with a sticky top banner indicating the view is cached until live sync completes. While cached mode is active, the composer is disabled.
- On successful reconnect, a fresh `state` message re-syncs the conversation.

### Agent Errors

- If the RPC subprocess crashes, the server sends an `error` WebSocket message. The UI displays the error inline in the conversation and provides a "Retry" button that re-spawns the subprocess.
- LLM provider errors (rate limits, auth failures, etc.) are surfaced as error messages inline in the conversation, as reported by the agent.

### Session Not Found

- Navigating to `/session/:id` where `:id` doesn't exist returns a 404-style page with a link back to the landing page.

---

## 12. Testing Strategy

The application must be testable autonomously — no manual verification required.

### API Integration Tests

Use an HTTP/WebSocket test client to verify:

- `GET /api/sessions` returns a valid session list.
- `POST /api/sessions` creates a session and returns an ID.
- `PATCH /api/sessions/:id` updates the session name.
- `DELETE /api/sessions/:id` removes the session.
- WebSocket connection to `/api/sessions/:id/ws` receives initial `state`.
- Sending a `prompt` over WebSocket results in streamed `agent_event` messages.
- Sending `abort` over WebSocket stops the agent.
- Sending `get_state` returns current state.
- `set_model` and `set_thinking_level` update the agent configuration.

### End-to-End Browser Tests

Use Playwright (headless browser) to verify:

- Landing page loads and displays session list.
- Clicking "+ New" creates a session and navigates to chat view.
- Chat view displays the session name and an empty conversation.
- Typing a message and pressing Send delivers it to the agent.
- Agent response streams in real-time, with tokens appearing incrementally.
- Tool calls appear inline with the correct format (collapsed by default).
- Expanding a tool call shows input/output.
- The Stop button appears during streaming and aborts the agent on click.
- Settings panel opens, displays current model and thinking level.
- Changing a setting applies it.
- Navigating back to landing page shows the updated session.
- Session rename works (context menu → rename → type new name).
- Session delete works (context menu → delete → confirm).
- Mobile viewport: layout is correct, input stays above keyboard area, touch targets are appropriately sized.
- Desktop viewport: message column is centered, settings appear as dropdown.
- Theme switching: toggling theme preference changes the color scheme.
- Page refresh preserves the current session (URL-based routing).

### Test Environment

- Tests run against a real server instance with a real LLM provider.
- Use an inexpensive model via OpenRouter (e.g., `google/glm-4.7-flash`) to keep costs low.
- The test environment uses a temporary `PI_SESSION_DIR` that is cleaned up after each test run.
- Tests must be runnable via a single command (e.g., `npm test`).
