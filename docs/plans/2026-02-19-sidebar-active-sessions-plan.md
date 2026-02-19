# Sidebar Active Sessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a bottom-aligned "active sessions" quick-link section to the chat-view desktop sidebar, showing recently active non-archived sessions with real-time updates.

**Architecture:** Extend the existing `renderChatSidebar()` function with new props for active sessions. Add SSE connection + initial fetch logic to `chat-view.ts`. Add CSS for the new section to `theme.css`.

**Tech Stack:** Lit 3.x, TypeScript, SSE (EventSource), CSS custom properties

---

### Task 1: Extend renderChatSidebar with active sessions section

**Files:**
- Modify: `src/client/utils/render-chat-sidebar.ts`

**Step 1: Add types and props for active sessions**

Add a new interface and extend the options:

```typescript
interface ActiveSessionItem {
  id: string;
  name: string;
  attached: boolean;
  activeHere: boolean;
}
```

Add `activeSessions: ActiveSessionItem[]` to `RenderChatSidebarOptions`.

**Step 2: Render the active sessions section**

After the `cv-tree-status` div and before the closing `</aside>`, add:

```typescript
${activeSessions.length > 0
  ? html`
      <div class="cv-sidebar-sessions">
        <div class="cv-sidebar-sessions-header">Sessions</div>
        ${activeSessions.map(
          (s) => html`
            <a class="cv-sidebar-session-item" href="#/session/${s.id}">
              ${s.attached
                ? html`<span class="cv-sidebar-session-dot active"></span>`
                : s.activeHere
                  ? html`<span class="cv-sidebar-session-dot idle"></span>`
                  : nothing}
              <span class="cv-sidebar-session-name">${s.name}</span>
            </a>
          `,
        )}
      </div>
    `
  : nothing}
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors (callers will be updated in Task 2)

---

### Task 2: Add session fetching and SSE to chat-view

**Files:**
- Modify: `src/client/components/chat-view.ts`

**Step 1: Add imports**

Add to the existing imports from `@shared/types.js`:
```typescript
import type { SessionMeta, SessionActivityUpdate } from "@shared/types.js";
```

Add:
```typescript
import { isArchivedSessionName, unarchiveSessionName } from "@shared/session-archive.js";
```

**Step 2: Add state properties**

Add to the `ChatView` class after the existing `@state()` declarations (around line 96):

```typescript
@state() private otherSessions: SessionMeta[] = [];
private sessionsEventSource: EventSource | null = null;
private sessionsSSEHasConnected = false;
```

**Step 3: Add fetch and SSE methods**

Add these methods to the class (after `resetSessionState`):

```typescript
private async loadOtherSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) return;
    const data = await res.json();
    this.otherSessions = data.sessions;
  } catch {
    // silent - this is supplementary UI
  }
}

private connectSessionsSSE() {
  this.sessionsEventSource = new EventSource("/api/sessions/events");
  this.sessionsSSEHasConnected = false;

  this.sessionsEventSource.onopen = () => {
    if (this.sessionsSSEHasConnected) {
      this.loadOtherSessions();
    }
    this.sessionsSSEHasConnected = true;
  };

  this.sessionsEventSource.onmessage = (e) => {
    const update: SessionActivityUpdate = JSON.parse(e.data);
    const session = this.otherSessions.find((s) => s.id === update.sessionId);
    if (session) {
      session.activity = update.activity;
      this.otherSessions = [...this.otherSessions];
    } else {
      this.loadOtherSessions();
    }
  };
}

private disconnectSessionsSSE() {
  if (this.sessionsEventSource) {
    this.sessionsEventSource.close();
    this.sessionsEventSource = null;
  }
}
```

**Step 4: Wire lifecycle**

In `connectedCallback` (after `window.addEventListener`), add:
```typescript
this.loadOtherSessions();
this.connectSessionsSSE();
```

In `disconnectedCallback` (after the existing `cleanup()` call), add:
```typescript
this.disconnectSessionsSSE();
```

**Step 5: Compute filtered active sessions and pass to sidebar**

Add a method that computes the active sessions list:

```typescript
private getActiveSessions(): ActiveSessionItem[] {
  const oneHourAgo = Date.now() - 3_600_000;
  return this.otherSessions
    .filter(
      (s) =>
        s.id !== this.sessionId &&
        !isArchivedSessionName(s.name) &&
        s.activity?.state !== "inactive" &&
        new Date(s.lastActivityAt).getTime() > oneHourAgo,
    )
    .map((s) => ({
      id: s.id,
      name: isArchivedSessionName(s.name)
        ? unarchiveSessionName(s.name)
        : s.name,
      attached: s.activity?.attached ?? false,
      activeHere: s.activity?.activeHere ?? false,
    }));
}
```

Import `ActiveSessionItem` from `render-chat-sidebar.ts`.

Update the `renderChatSidebar` call in the `render()` method (around line 596) to pass the new prop:

```typescript
${renderChatSidebar({
  search: this.sidebarSearch,
  filter: this.sidebarFilter,
  entries: sidebarEntries,
  activeSessions: this.getActiveSessions(),
  onSearchInput: (e) => (this.sidebarSearch = (e.target as HTMLInputElement).value),
  onSelectFilter: (mode) => (this.sidebarFilter = mode),
  onFocusMessage: (targetId) => this.focusMessage(targetId),
})}
```

**Step 6: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 3: Add CSS styles

**Files:**
- Modify: `src/client/styles/theme.css`

**Step 1: Add styles after the `.cv-tree-status` rule (after line 378)**

```css
.cv-sidebar-sessions {
  border-top: 1px solid var(--dim);
  padding: 6px 0 4px;
  flex-shrink: 0;
}

.cv-sidebar-sessions-header {
  padding: 0 12px 4px;
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.cv-sidebar-session-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px;
  font-size: 11px;
  color: var(--text-primary);
  text-decoration: none;
  cursor: pointer;
}

.cv-sidebar-session-item:hover {
  background: var(--selectedBg);
}

.cv-sidebar-session-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.cv-sidebar-session-dot.active {
  background: #22c55e;
}

.cv-sidebar-session-dot.idle {
  background: #9ca3af;
}

.cv-sidebar-session-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
```

**Step 2: Verify styles load**

Run: `npm run dev` and open in browser, navigate to a session on desktop width.
Expected: if there are active sessions, they appear at the bottom of the sidebar.

---

### Task 4: Commit

**Step 1: Commit all changes**

```bash
git add src/client/utils/render-chat-sidebar.ts src/client/components/chat-view.ts src/client/styles/theme.css
git commit -m "feat: show active sessions quick-links in chat sidebar (#9)"
```

---

### Task 5: E2E test

**Files:**
- Modify: `tests/e2e/app.spec.ts`

**Step 1: Add test for sidebar active sessions**

Add a new describe block:

```typescript
test.describe("Sidebar Active Sessions", () => {
  test("shows other active sessions in sidebar on desktop", async ({
    page,
    baseURL,
  }) => {
    // Create two sessions so one shows in the other's sidebar
    const id1 = await createSession(baseURL!);
    const id2 = await createSession(baseURL!);

    await fetch(`${baseURL}/api/sessions/${id1}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Session Alpha" }),
    });
    await fetch(`${baseURL}/api/sessions/${id2}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Session Beta" }),
    });

    try {
      // Set desktop viewport to ensure sidebar is visible
      await page.setViewportSize({ width: 1200, height: 800 });
      await openSession(page, id1);

      // The other session (id2) should appear in the sidebar quick-links
      // (if it has recent activity, which it does since just created)
      const sessionLink = page.locator(".cv-sidebar-session-item").filter({
        hasText: "Session Beta",
      });
      await expect(sessionLink).toBeVisible({ timeout: 5000 });

      // Clicking it navigates to that session
      await sessionLink.click();
      await expect(page).toHaveURL(new RegExp(`#/session/${id2}`));
    } finally {
      await deleteSession(baseURL!, id1);
      await deleteSession(baseURL!, id2);
    }
  });
});
```

**Step 2: Run the test**

Run: `npx playwright test tests/e2e/app.spec.ts --grep "Sidebar Active Sessions"`
Expected: PASS

**Step 3: Run the full e2e suite**

Run: `npx playwright test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add tests/e2e/app.spec.ts
git commit -m "test: e2e for sidebar active sessions quick-links (#9)"
```
