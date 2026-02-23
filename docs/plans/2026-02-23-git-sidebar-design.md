# Git sidebar design

Date: 2026-02-23

## Goal

Add repository awareness to the chat sidebar so users can quickly inspect staged/unstaged files, recent commits, and per-file diffs without leaving the chat view.

## UX

The left sidebar now has three stacked areas:

1. Git panel
2. Message navigation search/filter and message list
3. Active sessions list

Git panel behavior:

- Shows branch and HEAD short SHA when the session cwd is in a Git repository.
- Shows staged and unstaged file lists in working-tree mode.
- Shows up to 16 recent commits.
- Selecting a commit switches the top list to files changed in that commit.
- Clicking a file opens a modal with a textual diff.
- Includes manual refresh and automatic refresh every 5 seconds.
- If cwd is not a repository, shows a non-repo empty state.

## Server design

New REST endpoints under `/api/sessions/:id/git/*`:

- `status`
- `commits`
- `commits/:sha/files`
- `diff`

Session ID is resolved to cwd via `SessionManager.getSessionCwd()`.

Git execution is encapsulated in `src/server/git-inspector.ts`, which runs `git` with `execFile` (no shell) and parses:

- `git status --porcelain=1`
- `git log --pretty=format`
- `git show --name-status`
- `git diff` / `git show --patch`

Invalid or non-repo states return empty/non-repo payloads instead of throwing in normal flows.

## Client design

`session-sidebar` owns git state and refresh lifecycle.

State includes:

- status snapshot
- commit list
- selected commit and its files
- diff modal state

Refresh strategy:

- initial load on connect
- 5-second polling interval
- additional refresh trigger on session SSE activity updates

Rendering is centralized in `render-chat-sidebar.ts` to keep markup logic in one place and preserve the existing sidebar composition.

## Tradeoffs

- Polling is simple and robust, but not fully event-driven.
- Diff rendering is plain textual patch output; no side-by-side or syntax-aware hunks.
- Commit selection and working-tree view share one panel area to avoid adding another column.
