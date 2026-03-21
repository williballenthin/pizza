import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { SessionMeta, SessionActivityState, SessionActivityUpdate } from "@shared/types.js";
import {
  archiveSessionName,
  isArchivedSessionName,
  unarchiveSessionName,
} from "@shared/session-archive.js";
import { fetchProjects, type ProjectInfo } from "../utils/session-actions.js";

@customElement("session-list")
export class SessionList extends LitElement {
  @state() private sessions: SessionMeta[] = [];
  @state() private loading = true;
  @state() private error = "";
  @state() private showProjectPicker = false;
  @state() private projects: ProjectInfo[] = [];
  @state() private cwdInput = "";

  private eventSource: EventSource | null = null;
  private sseHasConnected = false;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      min-width: 0;
      overflow: hidden;
      background: var(--bg);
      line-height: 1.5;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
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
      overflow-x: hidden;
      padding: 0;
    }

    .session-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px 8px 20px;
      border-bottom: 0px solid transparent;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
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

    .archive-section-header {
      padding: 20px 20px 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      opacity: 0.6;
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
      flex: 1;
      min-width: 0;
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

    .session-archive-btn {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.35;
      transition: opacity 120ms ease, color 120ms ease;
    }

    .session-archive-btn:hover,
    .session-archive-btn:focus-visible {
      opacity: 1;
      color: var(--text-primary);
      outline: none;
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

    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
    }

    .project-picker {
      position: fixed;
      top: 44px;
      right: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      z-index: 1000;
      min-width: 280px;
      max-width: 360px;
      padding: 8px 0;
    }

    .project-picker-label {
      padding: 4px 16px 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }

    .project-item {
      display: block;
      width: 100%;
      padding: 8px 16px;
      border: none;
      background: none;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
      color: var(--text-primary);
    }

    .project-item:hover {
      background: var(--surface-alt);
    }

    .project-item-path {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .project-item-meta {
      font-size: 11px;
      color: var(--muted);
      margin-top: 1px;
    }

    .project-picker-divider {
      margin: 6px 0;
      border: none;
      border-top: 1px solid var(--borderMuted);
    }

    .project-cwd-form {
      display: flex;
      gap: 6px;
      padding: 4px 10px 6px;
    }

    .project-cwd-input {
      flex: 1;
      padding: 4px 8px;
      border: 1px solid var(--borderMuted);
      border-radius: 4px;
      background: var(--bg);
      color: var(--text-primary);
      font-size: 12px;
      font-family: monospace;
      outline: none;
    }

    .project-cwd-input:focus {
      border-color: var(--borderAccent);
    }

    .project-cwd-go {
      padding: 4px 10px;
      border: 1px solid var(--borderMuted);
      border-radius: 4px;
      background: var(--bg);
      color: var(--text-primary);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }

    .project-cwd-go:hover {
      background: var(--surface-alt);
    }

    .projects-section {
      flex: 0 1 min(40%, 320px);
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      border-top: 1px solid var(--borderMuted);
      padding: 8px 0 4px;
    }

    .projects-section-header {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 4px 20px 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      opacity: 0.9;
      background: var(--bg);
    }

    .project-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px 4px 20px;
    }

    .project-row-path {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .project-row-count {
      font-size: 11px;
      color: var(--muted);
      opacity: 0.6;
      flex-shrink: 0;
    }

    .project-row-new {
      flex-shrink: 0;
      padding: 2px 8px;
      border: 1px solid var(--borderMuted);
      border-radius: 4px;
      background: transparent;
      color: var(--muted);
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }

    .project-row-new:hover {
      background: var(--surface-alt);
      color: var(--text-primary);
    }

    .projects-empty {
      padding: 6px 20px 8px;
      font-size: 12px;
      color: var(--muted);
      opacity: 0.6;
    }

    @media (max-width: 980px) {
      .project-picker {
        top: 44px;
        right: 8px;
        left: 8px;
        min-width: 0;
        max-width: none;
      }

      .project-item-path,
      .project-row-path {
        overflow-wrap: anywhere;
        word-break: break-word;
      }
    }

    @media (max-width: 980px) and (pointer: coarse) {
      :host .project-cwd-input {
        font-size: 16px;
      }
    }

    :host,
    :host * {
      font-size: var(--ui-font-size, 12px);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.loadSessions();
    this.connectSSE();
    fetchProjects().then((projects) => {
      this.projects = projects;
    });
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

  private openProjectPicker() {
    this.cwdInput = "";
    this.showProjectPicker = true;
    fetchProjects().then((projects) => {
      this.projects = projects;
    });
  }

  private closeProjectPicker() {
    this.showProjectPicker = false;
  }

  private async createSessionWithCwd(cwd: string) {
    this.showProjectPicker = false;
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      window.location.hash = `#/session/${data.id}`;
    } catch (e) {
      this.error = `Failed to create session: ${e}`;
    }
  }

  private onCwdInputKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = this.cwdInput.trim();
      if (val) this.createSessionWithCwd(val);
    } else if (e.key === "Escape") {
      this.closeProjectPicker();
    }
  }

  // ---- Archive ----

  private async toggleArchive(e: MouseEvent, session: SessionMeta) {
    e.preventDefault();
    e.stopPropagation();
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

  // ---- Render ----

  render() {
    const recentProjects = this.getProjectsByMostRecentDesc();

    return html`
      <header>
        <h1>🍕</h1>
        <button class="new-btn" @click=${this.openProjectPicker}>
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

      <div class="projects-section">
        <div class="projects-section-header">Projects</div>
        ${recentProjects.length === 0
          ? html`<div class="projects-empty">No projects found. Use pi in a project directory first.</div>`
          : recentProjects.map(
              (p) => html`
                <div class="project-row">
                  <div class="project-row-path">${p.displayPath}</div>
                  <div class="project-row-count">${p.sessionCount} session${p.sessionCount === 1 ? "" : "s"}</div>
                  <button class="project-row-new" @click=${() => this.createSessionWithCwd(p.cwd)}>New</button>
                </div>
              `,
            )}
      </div>

      ${this.showProjectPicker
        ? html`
            <div class="backdrop" @click=${this.closeProjectPicker}></div>
            <div class="project-picker">
              <div class="project-picker-label">Directory</div>
              <div class="project-cwd-form">
                <input
                  class="project-cwd-input"
                  type="text"
                  placeholder="/path/to/project"
                  autofocus
                  .value=${this.cwdInput}
                  @input=${(e: InputEvent) => (this.cwdInput = (e.target as HTMLInputElement).value)}
                  @keydown=${this.onCwdInputKeydown}
                />
                <button
                  class="project-cwd-go"
                  @click=${() => {
                    const val = this.cwdInput.trim();
                    if (val) this.createSessionWithCwd(val);
                  }}
                >Go</button>
              </div>
            </div>
          `
        : nothing}
    `;
  }

  private getProjectsByMostRecentDesc(): ProjectInfo[] {
    return [...this.projects].sort((a, b) => {
      const byActivity =
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime();
      if (byActivity !== 0) return byActivity;
      return b.sessionCount - a.sessionCount;
    });
  }

  private getTimeGroup(iso: string): number {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = diff / 60_000;
    if (minutes < 15) return 0;
    if (minutes < 480) return 1;
    if (minutes < 1440) return 2;
    return 3;
  }

  private renderGroupedList(sessions: SessionMeta[]) {
    const items: unknown[] = [];
    const grouped = new Map<number, SessionMeta[]>();
    for (const s of sessions) {
      const group = this.getTimeGroup(s.lastActivityAt);
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group)!.push(s);
    }
    let first = true;
    for (const group of [...grouped.keys()].sort((a, b) => a - b)) {
      if (!first) items.push(html`<div class="group-spacer"></div>`);
      first = false;
      for (const s of grouped.get(group)!) {
        items.push(this.renderSession(s));
      }
    }
    return items;
  }

  private renderGroupedSessions() {
    const active = this.sessions.filter((s) => !isArchivedSessionName(s.name));
    const archived = this.sessions.filter((s) => isArchivedSessionName(s.name));
    return html`
      ${this.renderGroupedList(active)}
      ${archived.length > 0
        ? html`
            <div class="archive-section-header">Archive</div>
            ${this.renderGroupedList(archived)}
          `
        : nothing}
    `;
  }

  private renderSession(s: SessionMeta) {
    const archived = isArchivedSessionName(s.name);
    const activity = this.getActivityPresentation(
      s.activity?.state ?? "inactive",
    );

    const metaParts = [
      relativeTime(s.lastActivityAt),
      ...(s.cwd ? [s.cwd] : []),
      `${s.messageStats?.totalMessages ?? 0} msg`,
      s.model || "unknown model",
    ];

    return html`
      <a
        class="session-item ${archived ? "archived" : ""}"
        href="#/session/${s.id}"
      >
        <div class="session-main">
          <div class="session-name-row">
            ${archived
              ? html`<span class="session-archived-badge">Archived</span>`
              : nothing}
            <div class="session-name">${this.getSessionDisplayName(s)}</div>
            ${activity
              ? html`
                  <span class="session-activity-badge ${activity.className}">
                    ${activity.label}
                  </span>
                `
              : nothing}
          </div>
          <div class="session-meta">
            ${metaParts.join(" · ")}
          </div>
        </div>
        ${s.activity?.isWorking
          ? html`<div class="session-status-spinner" title="Agent working"></div>`
          : nothing}
        ${s.activity?.attached
          ? html`<span class="session-status-icon active" title="Active user">●</span>`
          : s.activity?.activeHere
            ? html`<span class="session-status-icon idle" title="Process running">●</span>`
            : nothing}
        <button
          class="session-archive-btn"
          title="${archived ? "Unarchive" : "Archive"}"
          aria-label="${archived ? "Unarchive session" : "Archive session"}"
          @click=${(e: MouseEvent) => this.toggleArchive(e, s)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="21 8 21 21 3 21 3 8"></polyline>
            <rect x="1" y="3" width="22" height="5"></rect>
            <line x1="10" y1="12" x2="14" y2="12"></line>
          </svg>
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
