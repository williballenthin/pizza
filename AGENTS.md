# Agent Guidelines

When making changes to this codebase:

1. **Lint** after every chunk of changes
2. **Test** after every chunk of changes
3. **Commit** after every chunk of changes

This ensures each commit represents a tested, working state and makes it easier to bisect issues if they arise.

## Commands

Use the justfile when possible:

```bash
just lint        # Run ESLint
just test        # Run all tests (API + E2E)
just test-api    # Run API/unit tests only
just test-e2e    # Run Playwright E2E tests
just build       # Build for production
```

Alternative npm scripts (if just is not available):

```bash
npm run lint     # Run ESLint
npm test         # Run all tests
npm run test:api # Run API/unit tests only
npm run test:e2e # Run Playwright E2E tests
npm run build    # Build for production
```

Note: E2E tests require the dev server to not be running on port 3001.

## Architecture

Express/Node backend manages Pi agent RPC subprocesses. Lit web components on the frontend. WebSocket proxies communication between client and Pi process. Sessions stored as JSONL files on disk. Vite builds the client, tsc compiles the server.

## Source files

```
src/server/
  main.ts              Entry point. Loads config, creates app, listens on port.
  config.ts            CLI args/env var parsing. ServerConfig interface. Path encoding helpers.
  app.ts               Creates Express app, HTTP server, WebSocket server. Serves static frontend.
  routes.ts            REST API: /api/health, /api/sessions (CRUD), /api/sessions/events (SSE), /api/projects.
  session-manager.ts   Session lifecycle. Spawns RPC processes, tracks clients, reads JSONL history, idle timeouts.
  ws-handler.ts        WebSocket message routing. Handles prompt/steer/follow_up/abort/bash/model/thinking commands.
  rpc-process.ts       Spawns `pi --mode rpc` subprocess. JSON line protocol. EventEmitter for events.
  project-registry.ts  Project discovery. Scans session buckets, decodes cwds, returns ProjectInfo[].

src/shared/
  types.ts             All shared types. ClientMessage/ServerMessage unions, SessionMeta, ThinkingLevel, etc.
  session-archive.ts   Archive/unarchive session name helpers.
  session-stats.ts     Counts user/assistant/tool messages from JSONL entries.

src/client/
  index.html           Root HTML. Loads theme.css and main.ts.
  main.ts              Client entry. Imports all components, theme init/persistence.
  styles/theme.css     CSS custom properties, dark/light themes, typography, syntax highlighting colors.

src/client/components/
  app-root.ts          Root Lit component. Hash-based routing: #/ (home) and #/session/:id (chat).
  chat-view.ts         Main chat interface. SessionRuntime connection, message list, input, sidebar, settings.
  message-list.ts      Renders messages with markdown/syntax highlighting. Tool calls, diffs, thinking blocks.
  chat-input.ts        Auto-expanding textarea. Image paste/drag-drop. Slash command autocomplete.
  session-list.ts      Home screen. Lists sessions, SSE activity updates, create/archive/delete.
  session-sidebar.ts   Side panel. Message history navigation, active session list, activity indicators.
  settings-panel.ts    Settings drawer. Theme, model, thinking level, steering mode, rename, archive.

src/client/utils/
  session-runtime.ts   WebSocket state machine. Connection, reconnection, message buffering, streaming.
  input-router.ts      Parses input into bash/prompt/steer/follow_up. Bang commands (!, !!).
  message-shaping.ts   Filters and transforms messages for rendering and sidebar navigation.
  extension-ui-state.ts  Extension UI request queue. Handles input/confirm/select dialogs from Pi.
  pi-export-render.ts  Markdown rendering, syntax highlighting, collapsible output, path shortening.
  render-chat-editor-footer.ts  Token usage display, tool list, agent working spinner, stop button.
  render-chat-sidebar.ts  Sidebar rendering. Active sessions, message nav, session metadata.
  render-extension-ui-dialog.ts  Extension UI modals. Select, confirm, input, editor, notify dialogs.
  render-session-info-stack.ts  Session metadata cards. Model, thinking level, steering mode info.
  session-actions.ts   HTTP helpers. fetchSessionInfo, patchSessionName, fetchProjects.

tests/api/             Vitest unit tests for sessions, input routing, project registry, message merging.
tests/e2e/             Playwright E2E tests for full application workflows.
```

**Important:** Never use `pkill -f "vite dev"` or similar blanket kill commands. There may be other services running that should not be interrupted. Only stop the specific process you started.

## Tools

- use `uvx rodney --local` to automate a persistent Chrome instance to load the application, interact with the interface, inspect its state, and create screenshots. stop instances once you're done with them.
- for reliable captures, open a known hash route first, then run `waitload` and `waitstable` before taking screenshots.
- verify UI state with `js` or `exists` before capture (for example, check that `settings-panel` is not open).
- `rodney screenshot -w/-h` sets output image dimensions, but does not change CSS viewport width (`window.innerWidth` stays at the default desktop size). use Playwright/device emulation if you need true responsive mobile layout.
- if captures look stale or inherit old tab state, run `uvx rodney --local stop`, remove `./.rodney/`, and start again.
