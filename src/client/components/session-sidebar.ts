import { LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionMeta, SessionActivityUpdate } from "@shared/types.js";
import { isArchivedSessionName, unarchiveSessionName } from "@shared/session-archive.js";
import {
  renderChatSidebar,
  type ActiveSessionItem,
} from "../utils/render-chat-sidebar.js";
import type { SidebarFilterMode, SidebarEntry } from "../utils/message-shaping.js";

@customElement("session-sidebar")
export class SessionSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) sessionId = "";
  @property({ type: String }) sidebarSearch = "";
  @property({ type: String }) sidebarFilter: SidebarFilterMode = "no-tools";
  @property({ type: Array }) entries: SidebarEntry[] = [];

  @state() private otherSessions: SessionMeta[] = [];

  private sessionsEventSource: EventSource | null = null;
  private sessionsSSEHasConnected = false;

  connectedCallback() {
    super.connectedCallback();
    this.loadOtherSessions();
    this.connectSessionsSSE();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disconnectSessionsSSE();
  }

  private async loadOtherSessions() {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = await res.json();
      this.otherSessions = data.sessions;
    } catch {
      // silent
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

  render() {
    return renderChatSidebar({
      search: this.sidebarSearch,
      filter: this.sidebarFilter,
      entries: this.entries,
      activeSessions: this.getActiveSessions(),
      onSearchInput: (e) =>
        this.dispatchEvent(new CustomEvent("search-input", { detail: (e.target as HTMLInputElement).value })),
      onSelectFilter: (mode) =>
        this.dispatchEvent(new CustomEvent("select-filter", { detail: mode })),
      onFocusMessage: (targetId) =>
        this.dispatchEvent(new CustomEvent("focus-message", { detail: targetId })),
    });
  }
}
