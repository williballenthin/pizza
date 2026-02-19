import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { SessionMeta, SessionActivityState, SessionActivityUpdate } from "@shared/types.js";
import {
  archiveSessionName,
  isArchivedSessionName,
  unarchiveSessionName,
} from "@shared/session-archive.js";

@customElement("session-list")
export class SessionList extends LitElement {
  @state() private sessions: SessionMeta[] = [];
  @state() private loading = true;
  @state() private error = "";
  @state() private contextMenuSessionId: string | null = null;
  @state() private contextMenuPos = { x: 0, y: 0 };
  @state() private renamingId: string | null = null;
  @state() private renameValue = "";

  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private eventSource: EventSource | null = null;
  private sseHasConnected = false;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg);
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-bottom: 1px solid var(--borderMuted);
      background: var(--surface);
      flex-shrink: 0;
    }

    header h1 {
      font-size: 14px;
      font-weight: 600;
      margin: 0;
      font-family: inherit;
    }

    .new-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border: 1px solid var(--borderMuted);
      border-radius: 4px;
      background: var(--bg);
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 600;
      line-height: 1.5;
      font-family: inherit;
      cursor: pointer;
      min-height: 28px;
      transition: border-color 120ms ease, background-color 120ms ease;
    }

    .new-btn:hover {
      background: var(--surface-alt);
      border-color: var(--dim);
    }

    .new-btn:focus-visible {
      outline: none;
      border-color: var(--borderAccent);
      box-shadow: 0 0 0 1px var(--borderAccent);
    }

    .new-btn .plus {
      color: var(--accent);
      font-weight: 700;
      font-size: 14px;
    }

    .list {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }

    .session-item {
      display: block;
      padding: 8px 20px;
      border-bottom: 0px solid transparent;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      position: relative;
      transition: background-color 150ms ease;
    }

    .session-item:not(:last-child) {
       margin-bottom: 2px;
    }

    .group-spacer {
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .group-spacer::after {
      content: "";
      display: block;
      width: 50%;
      height: 1px;
      background: var(--borderMuted);
      opacity: 0.5;
    }

    .session-item:hover {
      background: var(--surface);
    }

    .session-item:active {
      background: var(--surface-alt);
    }

    .session-item.archived {
      opacity: 0.62;
    }

    .session-item.archived .session-name {
      color: var(--muted);
      font-weight: 500;
      font-family: inherit;
    }

    .session-main {
      padding-right: 40px;
    }

    .session-name-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 2px;
      min-width: 0;
    }

    .session-name {
      font-weight: 700;
      font-size: 14px;
      line-height: 1.5;
      color: #ffffff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
      font-family: inherit;
    }

    .session-archived-badge {
      border: 1px solid var(--borderMuted);
      color: var(--muted);
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }

    .session-activity-badge {
      border: 1px solid var(--borderMuted);
      color: var(--muted);
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      flex-shrink: 0;
    }

    .session-activity-badge.warm {
      border-color: rgba(245, 158, 11, 0.5);
      color: #b45309;
    }

    .session-status-spinner {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(156, 163, 175, 0.5);
      border-top-color: #ffffff;
      border-radius: 50%;
      flex-shrink: 0;
      animation: spin 1s linear infinite;
    }
    
    .session-status-icon {
      font-size: 10px;
      flex-shrink: 0;
    }
    
    .session-status-icon.active {
      color: #22c55e;
    }
    
    .session-status-icon.idle {
      color: #9ca3af;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .session-meta {
      font-size: 14px;
      line-height: 1.5;
      color: var(--muted);
      font-family: inherit;
    }

    .session-menu-btn {
      position: absolute;
      top: 50%;
      right: 12px;
      transform: translateY(-50%);
      width: 26px;
      height: 26px;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 120ms ease;
    }

    .session-item:hover .session-menu-btn {
      opacity: 1;
    }

    .session-item:hover .session-menu-btn:hover,
    .session-menu-btn:focus-visible {
      opacity: 1;
      border-color: var(--borderMuted);
      background: var(--surface-alt);
      color: var(--text-primary);
      outline: none;
    }

    .rename-input {
      font-weight: 600;
      font-size: 14px;
      padding: 2px 6px;
      border: 2px solid var(--accent);
      border-radius: 4px;
      background: var(--bg);
      color: var(--text-primary);
      width: 100%;
      outline: none;
      font-family: inherit;
    }

    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: var(--text-secondary);
      gap: 12px;
      padding: 40px;
      text-align: center;
    }

    .empty-icon {
      font-size: 24px;
      opacity: 0.5;
    }

    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: var(--text-secondary);
    }

    .error-banner {
      padding: 12px 20px;
      background: var(--error-bg);
      color: var(--error);
      font-size: 14px;
    }

    /* Context menu */
    .context-menu {
      position: fixed;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      z-index: 1000;
      min-width: 140px;
      padding: 4px 0;
    }

    .context-menu button {
      display: block;
      width: 100%;
      padding: 10px 16px;
      border: none;
      background: none;
      color: var(--text-primary);
      font-size: 14px;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
    }

    .context-menu button:hover {
      background: var(--surface-alt);
    }

    .context-menu .danger {
      color: var(--error);
    }

    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.loadSessions();
    this.connectSSE();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private connectSSE() {
    this.eventSource = new EventSource("/api/sessions/events");
    this.sseHasConnected = false;

    this.eventSource.onopen = () => {
      if (this.sseHasConnected) {
        this.loadSessions();
      }
      this.sseHasConnected = true;
    };

    this.eventSource.onmessage = (e) => {
      const update: SessionActivityUpdate = JSON.parse(e.data);
      const session = this.sessions.find((s) => s.id === update.sessionId);
      if (session) {
        session.activity = update.activity;
        this.sessions = [...this.sessions];
      } else {
        this.loadSessions();
      }
    };
  }

  private async loadSessions() {
    this.loading = true;
    this.error = "";
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.sessions = data.sessions;
    } catch (e) {
      this.error = `Failed to load sessions: ${e}`;
    } finally {
      this.loading = false;
    }
  }

  private async createSession() {
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      window.location.hash = `#/session/${data.id}`;
    } catch (e) {
      this.error = `Failed to create session: ${e}`;
    }
  }

  // ---- Context menu ----

  private showContextMenu(id: string, x: number, y: number) {
    this.contextMenuSessionId = id;
    this.contextMenuPos = { x, y };
  }

  private closeContextMenu() {
    this.contextMenuSessionId = null;
  }

  private onTouchStart(e: TouchEvent, id: string) {
    const touch = e.touches[0];
    this.longPressTimer = setTimeout(() => {
      this.showContextMenu(id, touch.clientX, touch.clientY);
    }, 500);
  }

  private onTouchEnd() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private openMenuFromButton(e: MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    this.showContextMenu(id, Math.max(8, rect.right - 140), rect.bottom + 4);
  }

  private getContextSession(): SessionMeta | undefined {
    if (!this.contextMenuSessionId) return undefined;
    return this.sessions.find((s) => s.id === this.contextMenuSessionId);
  }

  // ---- Archive ----

  private async toggleArchive() {
    const session = this.getContextSession();
    this.closeContextMenu();
    if (!session) return;

    const archived = isArchivedSessionName(session.name);
    const name = archived
      ? unarchiveSessionName(session.name).trim() || "Session"
      : archiveSessionName(session.name);

    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      session.name = name;
      this.requestUpdate();
    } catch (e) {
      this.error = `Failed to update session: ${e}`;
    }
  }

  // ---- Rename ----

  private startRename() {
    const session = this.sessions.find(
      (s) => s.id === this.contextMenuSessionId,
    );
    if (session) {
      this.renamingId = session.id;
      this.renameValue = session.name;
    }
    this.closeContextMenu();
  }

  private async commitRename() {
    if (!this.renamingId) return;
    const name = this.renameValue.trim();
    if (!name) {
      this.renamingId = null;
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${this.renamingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = this.sessions.find((s) => s.id === this.renamingId);
      if (s) s.name = name;
      this.requestUpdate();
    } catch (e) {
      this.error = `Failed to rename session: ${e}`;
    }
    this.renamingId = null;
  }

  private onRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.commitRename();
    } else if (e.key === "Escape") {
      this.renamingId = null;
    }
  }

  // ---- Delete ----

  private async deleteSession() {
    const session = this.getContextSession();
    this.closeContextMenu();
    if (!session) return;
    if (!confirm("Delete this session?")) return;

    try {
      const res = await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.sessions = this.sessions.filter((s) => s.id !== session.id);
    } catch (e) {
      this.error = `Failed to delete session: ${e}`;
    }
  }

  // ---- Render ----

  render() {
    return html`
      <header>
        <h1>🍕</h1>
        <button class="new-btn" @click=${this.createSession}>
          <span class="plus">+</span>
          <span>New session</span>
        </button>
      </header>

      ${this.error ? html`<div class="error-banner">${this.error}</div>` : nothing}

      ${this.loading
        ? html`<div class="loading">Loading sessions...</div>`
        : this.sessions.length === 0
          ? html`
              <div class="empty">
                <div class="empty-icon">&#128172;</div>
                <div>No sessions yet</div>
                <div>Start a new session to begin</div>
              </div>
            `
          : html`
              <div class="list">
                ${this.renderGroupedSessions()}
              </div>
            `}

      ${this.contextMenuSessionId !== null
        ? html`
            <div class="backdrop" @click=${this.closeContextMenu}></div>
            <div
              class="context-menu"
              style="left:${this.contextMenuPos.x}px;top:${this.contextMenuPos.y}px"
            >
              <button @click=${this.toggleArchive}>
                ${isArchivedSessionName(this.getContextSession()?.name || "")
                  ? "Unarchive"
                  : "Archive"}
              </button>
              <button @click=${this.startRename}>
                Rename
              </button>
              <button class="danger" @click=${this.deleteSession}>
                Delete
              </button>
            </div>
          `
        : nothing}
    `;
  }

  private getTimeGroup(iso: string): number {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = diff / 60_000;
    if (minutes < 15) return 0;
    if (minutes < 480) return 1;
    if (minutes < 1440) return 2;
    return 3;
  }

  private renderGroupedSessions() {
    const items: unknown[] = [];
    let lastGroup = -1;
    for (const s of this.sessions) {
      const group = this.getTimeGroup(s.lastActivityAt);
      if (lastGroup !== -1 && group !== lastGroup) {
        items.push(html`<div class="group-spacer"></div>`);
      }
      lastGroup = group;
      items.push(this.renderSession(s));
    }
    return items;
  }

  private renderSession(s: SessionMeta) {
    const isRenaming = this.renamingId === s.id;
    const archived = isArchivedSessionName(s.name);
    const activity = this.getActivityPresentation(
      s.activity?.state ?? "inactive",
    );

    const metaParts = [
      `${s.messageStats?.totalMessages ?? 0} msg`,
      s.model || "unknown model",
      relativeTime(s.lastActivityAt),
    ];
    if (s.cwd) metaParts.push(s.cwd);

    return html`
      <a
        class="session-item ${archived ? "archived" : ""}"
        href="#/session/${s.id}"
        @touchstart=${(e: TouchEvent) => this.onTouchStart(e, s.id)}
        @touchend=${this.onTouchEnd}
        @touchcancel=${this.onTouchEnd}
      >
        <div class="session-main">
          ${isRenaming
            ? html`
                <input
                  class="rename-input"
                  .value=${this.renameValue}
                  @input=${(e: InputEvent) =>
                    (this.renameValue = (e.target as HTMLInputElement).value)}
                  @keydown=${this.onRenameKeydown}
                  @blur=${this.commitRename}
                  @click=${(e: Event) => e.stopPropagation()}
                />
              `
            : html`
                <div class="session-name-row">
                  <div class="session-name">${this.getSessionDisplayName(s)}</div>
                  ${archived
                    ? html`<span class="session-archived-badge">Archived</span>`
                    : nothing}
                  ${s.activity?.isWorking
                    ? html`<div class="session-status-spinner" title="Agent working"></div>`
                    : nothing}
                  ${s.activity?.attached
                    ? html`<span class="session-status-icon active" title="Active user">●</span>`
                    : s.activity?.activeHere
                      ? html`<span class="session-status-icon idle" title="Process running">●</span>`
                      : nothing}
                  ${activity
                    ? html`
                        <span class="session-activity-badge ${activity.className}">
                          ${activity.label}
                        </span>
                      `
                    : nothing}
                </div>
              `}
          <div class="session-meta">
            ${metaParts.join(" · ")}
          </div>
        </div>
        <button
          class="session-menu-btn"
          title="Session actions"
          aria-label="Session actions"
          @click=${(e: MouseEvent) => this.openMenuFromButton(e, s.id)}
        >
          ⋯
        </button>
      </a>
    `;
  }

  private getSessionDisplayName(session: SessionMeta): string {
    return isArchivedSessionName(session.name)
      ? unarchiveSessionName(session.name)
      : session.name;
  }

  private getActivityPresentation(
    state: SessionActivityState,
  ): { label: string; className: string } | null {
    switch (state) {
      case "warm":
        return { label: "Warm", className: "warm" };
      default:
        return null;
    }
  }

  updated() {
    // Auto-focus rename input
    if (this.renamingId) {
      const input = this.shadowRoot?.querySelector(
        ".rename-input",
      ) as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    }
  }
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
