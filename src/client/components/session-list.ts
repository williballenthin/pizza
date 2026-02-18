import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { SessionMeta, SessionActivityState } from "@shared/types.js";
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
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      flex-shrink: 0;
    }

    header h1 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .new-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border: 1px solid var(--borderMuted);
      border-radius: 4px;
      background: var(--bg);
      color: var(--text-primary);
      font-size: 0.85rem;
      font-weight: 600;
      line-height: 1;
      font-family: inherit;
      cursor: pointer;
      min-height: 34px;
      min-width: 34px;
      transition: border-color 120ms ease, background-color 120ms ease;
    }

    .new-btn:hover {
      background: var(--surface-alt);
      border-color: var(--border);
    }

    .new-btn:focus-visible {
      outline: none;
      border-color: var(--borderAccent);
      box-shadow: 0 0 0 1px var(--borderAccent);
    }

    .new-btn .plus {
      color: var(--accent);
      font-weight: 700;
      font-size: 0.95rem;
    }

    .list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }

    .session-item {
      display: block;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      position: relative;
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
      color: var(--text-secondary);
      font-weight: 500;
    }

    .session-item.muted {
      opacity: 0.56;
      cursor: not-allowed;
    }

    .session-item.muted:hover,
    .session-item.muted:active {
      background: transparent;
    }

    .session-main {
      padding-right: 34px;
    }

    .session-name-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      min-width: 0;
    }

    .session-name {
      font-weight: 600;
      font-size: 1rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }

    .session-archived-badge {
      border: 1px solid var(--borderMuted);
      color: var(--text-secondary);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 0.62rem;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }

    .session-activity-badge {
      border: 1px solid var(--borderMuted);
      color: var(--text-secondary);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 0.62rem;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      flex-shrink: 0;
    }

    .session-activity-badge.attached {
      border-color: rgba(34, 197, 94, 0.55);
      color: #16a34a;
    }

    .session-activity-badge.active_here {
      border-color: rgba(59, 130, 246, 0.45);
      color: #1d4ed8;
    }

    .session-activity-badge.idle,
    .session-activity-badge.warm {
      border-color: rgba(245, 158, 11, 0.5);
      color: #b45309;
    }

    .session-activity-badge.recently_edited_elsewhere {
      border-color: rgba(220, 38, 38, 0.45);
      color: var(--error);
    }

    .session-meta {
      font-size: 0.85rem;
      color: var(--text-secondary);
    }

    .session-muted-reason {
      margin-top: 4px;
      font-size: 0.78rem;
      color: var(--error);
    }

    .session-menu-btn {
      position: absolute;
      top: 10px;
      right: 12px;
      width: 26px;
      height: 26px;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.75;
    }

    .session-item:hover .session-menu-btn,
    .session-menu-btn:focus-visible {
      opacity: 1;
      border-color: var(--borderMuted);
      background: var(--surface-alt);
      color: var(--text-primary);
      outline: none;
    }

    .session-menu-btn:disabled {
      cursor: not-allowed;
      opacity: 0.35;
    }

    .rename-input {
      font-weight: 600;
      font-size: 1rem;
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
      font-size: 2rem;
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
      font-size: 0.9rem;
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
      font-size: 0.9rem;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
    }

    .context-menu button:hover {
      background: var(--surface-alt);
    }

    .context-menu button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      background: transparent;
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

  private openSession(id: string) {
    if (this.renamingId || this.contextMenuSessionId) return;
    const session = this.sessions.find((s) => s.id === id);
    if (!session || this.isSessionMuted(session)) return;
    window.location.hash = `#/session/${id}`;
  }

  // ---- Context menu ----

  private showContextMenu(id: string, x: number, y: number) {
    this.contextMenuSessionId = id;
    this.contextMenuPos = { x, y };
  }

  private closeContextMenu() {
    this.contextMenuSessionId = null;
  }

  private onContextMenu(e: MouseEvent, id: string) {
    const session = this.sessions.find((s) => s.id === id);
    if (!session || this.isSessionMuted(session)) return;
    e.preventDefault();
    this.showContextMenu(id, e.clientX, e.clientY);
  }

  private onTouchStart(e: TouchEvent, id: string) {
    const session = this.sessions.find((s) => s.id === id);
    if (!session || this.isSessionMuted(session)) return;
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
    const session = this.sessions.find((s) => s.id === id);
    if (!session || this.isSessionMuted(session)) return;
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
    if (!session || this.isSessionMuted(session)) return;

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
    if (session && !this.isSessionMuted(session)) {
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
    if (!session || this.isSessionMuted(session)) return;
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
        <h1>Pi Web UI</h1>
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
                ${this.sessions.map((s) => this.renderSession(s))}
              </div>
            `}

      ${this.contextMenuSessionId !== null
        ? html`
            <div class="backdrop" @click=${this.closeContextMenu}></div>
            <div
              class="context-menu"
              style="left:${this.contextMenuPos.x}px;top:${this.contextMenuPos.y}px"
            >
              <button
                ?disabled=${this.isSessionMuted(this.getContextSession())}
                @click=${this.toggleArchive}
              >
                ${isArchivedSessionName(this.getContextSession()?.name || "")
                  ? "Unarchive"
                  : "Archive"}
              </button>
              <button
                ?disabled=${this.isSessionMuted(this.getContextSession())}
                @click=${this.startRename}
              >
                Rename
              </button>
              <button
                class="danger"
                ?disabled=${this.isSessionMuted(this.getContextSession())}
                @click=${this.deleteSession}
              >
                Delete
              </button>
            </div>
          `
        : nothing}
    `;
  }

  private renderSession(s: SessionMeta) {
    const isRenaming = this.renamingId === s.id;
    const archived = isArchivedSessionName(s.name);
    const muted = this.isSessionMuted(s);
    const mutedReason = this.getMutedReason(s);
    const activity = this.getActivityPresentation(
      s.activity?.state ?? "inactive",
    );

    return html`
      <div
        class="session-item ${archived ? "archived" : ""} ${muted ? "muted" : ""}"
        title=${mutedReason ?? ""}
        aria-label=${mutedReason ?? this.getSessionDisplayName(s)}
        @click=${() => this.openSession(s.id)}
        @contextmenu=${(e: MouseEvent) => this.onContextMenu(e, s.id)}
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
            ${s.messageCount} messages &middot; ${relativeTime(s.lastActivityAt)}
          </div>
          ${mutedReason
            ? html`<div class="session-muted-reason">${mutedReason}</div>`
            : nothing}
        </div>
        <button
          class="session-menu-btn"
          title="Session actions"
          aria-label="Session actions"
          ?disabled=${muted}
          @click=${(e: MouseEvent) => this.openMenuFromButton(e, s.id)}
        >
          ⋯
        </button>
      </div>
    `;
  }

  private getSessionDisplayName(session: SessionMeta): string {
    return isArchivedSessionName(session.name)
      ? unarchiveSessionName(session.name)
      : session.name;
  }

  private isSessionMuted(session: SessionMeta | undefined): boolean {
    return !!session?.activity?.muted;
  }

  private getMutedReason(session: SessionMeta | undefined): string | null {
    if (!session || !this.isSessionMuted(session)) return null;
    if (session.activity?.state === "recently_edited_elsewhere") {
      return "Updated recently but with no local activity. Likely in use by another Pi instance.";
    }
    return "Session is currently unavailable from this instance.";
  }

  private getActivityPresentation(
    state: SessionActivityState,
  ): { label: string; className: string } | null {
    switch (state) {
      case "attached":
        return { label: "Attached", className: "attached" };
      case "idle":
        return { label: "Idle", className: "idle" };
      case "warm":
        return { label: "Warm", className: "warm" };
      case "recently_edited_elsewhere":
        return { label: "In use elsewhere", className: "recently_edited_elsewhere" };
      case "active_here":
        return { label: "Active here", className: "active_here" };
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
