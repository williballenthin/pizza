import { LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionMeta } from "@shared/types.js";
import { isArchivedSessionName, unarchiveSessionName } from "@shared/session-archive.js";
import {
  fetchSessionGitCommitFiles,
  fetchSessionGitCommits,
  fetchSessionGitDiff,
  fetchSessionGitStatus,
  type GitCommitSummary,
  type GitFileChange,
  type GitStatusSnapshot,
} from "../utils/session-actions.js";
import {
  renderChatSidebar,
  type ActiveSessionItem,
  type GitDiffRequest,
  CURRENT_INDEX_SELECTION,
} from "../utils/render-chat-sidebar.js";
import type { SidebarFilterMode, SidebarEntry } from "../utils/message-shaping.js";
import { subscribeSessionActivity } from "../utils/session-activity-source.js";

@customElement("session-sidebar")
export class SessionSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) sessionId = "";
  @property({ type: String }) sidebarSearch = "";
  @property({ type: String }) sidebarFilter: SidebarFilterMode = "user-only";
  @property({ type: Array }) entries: SidebarEntry[] = [];

  @state() private otherSessions: SessionMeta[] = [];
  @state() private gitStatus: GitStatusSnapshot | null = null;
  @state() private gitCommits: GitCommitSummary[] = [];
  @state() private selectedCommitSha = CURRENT_INDEX_SELECTION;
  @state() private selectedCommitFiles: GitFileChange[] = [];
  @state() private gitLoading = false;
  @state() private gitError = "";
  @state() private diffOpen = false;
  @state() private diffTitle = "";
  @state() private diffText = "";
  @state() private diffLoading = false;

  private unsubscribeSessionsActivity: (() => void) | null = null;
  private gitRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private gitRequestId = 0;
  private diffRequestId = 0;

  connectedCallback() {
    super.connectedCallback();
    void this.loadOtherSessions();
    this.connectSessionsSSE();
    this.startGitPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disconnectSessionsSSE();
    this.stopGitPolling();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("sessionId")) {
      this.resetGitState();
      void this.refreshGitData(true);
    }
  }

  private async loadOtherSessions() {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = await res.json();
      this.otherSessions = data.sessions;
    } catch {
      return;
    }
  }

  private connectSessionsSSE() {
    this.unsubscribeSessionsActivity?.();
    this.unsubscribeSessionsActivity = subscribeSessionActivity((update) => {
      const session = this.otherSessions.find((s) => s.id === update.sessionId);
      if (session) {
        session.activity = update.activity;
        this.otherSessions = [...this.otherSessions];
      } else {
        void this.loadOtherSessions();
      }

      if (update.sessionId === this.sessionId) {
        void this.refreshGitData(false);
      }
    });
  }

  private disconnectSessionsSSE() {
    if (this.unsubscribeSessionsActivity) {
      this.unsubscribeSessionsActivity();
      this.unsubscribeSessionsActivity = null;
    }
  }

  private startGitPolling() {
    this.stopGitPolling();
    this.gitRefreshTimer = setInterval(() => {
      void this.refreshGitData(false);
    }, 5000);
  }

  private stopGitPolling() {
    if (!this.gitRefreshTimer) return;
    clearInterval(this.gitRefreshTimer);
    this.gitRefreshTimer = null;
  }

  private resetGitState() {
    this.gitStatus = null;
    this.gitCommits = [];
    this.selectedCommitSha = CURRENT_INDEX_SELECTION;
    this.selectedCommitFiles = [];
    this.gitLoading = false;
    this.gitError = "";
    this.closeDiff();
  }

  private async refreshGitData(showLoading: boolean) {
    if (!this.sessionId) return;

    const requestId = ++this.gitRequestId;
    if (showLoading) this.gitLoading = true;

    const [status, commits] = await Promise.all([
      fetchSessionGitStatus(this.sessionId),
      fetchSessionGitCommits(this.sessionId, 16),
    ]);

    if (requestId !== this.gitRequestId) return;

    if (!status) {
      this.gitStatus = null;
      this.gitCommits = [];
      this.selectedCommitSha = CURRENT_INDEX_SELECTION;
      this.selectedCommitFiles = [];
      this.gitError = "Failed to load git metadata";
      this.gitLoading = false;
      return;
    }

    this.gitStatus = status;
    this.gitCommits = commits;
    this.gitError = "";

    if (
      this.selectedCommitSha !== CURRENT_INDEX_SELECTION &&
      !commits.some((commit) => commit.hash === this.selectedCommitSha)
    ) {
      this.selectedCommitSha = CURRENT_INDEX_SELECTION;
      this.selectedCommitFiles = [];
    }

    if (this.selectedCommitSha !== CURRENT_INDEX_SELECTION) {
      await this.loadSelectedCommitFiles(this.selectedCommitSha);
      if (requestId !== this.gitRequestId) return;
    } else {
      this.selectedCommitFiles = [];
    }

    this.gitLoading = false;
  }

  private async loadSelectedCommitFiles(sha: string) {
    if (!this.sessionId || !sha || sha === CURRENT_INDEX_SELECTION) return;
    const files = await fetchSessionGitCommitFiles(this.sessionId, sha);

    if (sha !== this.selectedCommitSha) return;

    this.selectedCommitFiles = files || [];
  }

  private selectCommit(sha: string) {
    if (sha === this.selectedCommitSha) return;

    this.selectedCommitSha = sha;
    this.selectedCommitFiles = [];

    if (sha !== CURRENT_INDEX_SELECTION) {
      void this.loadSelectedCommitFiles(sha);
    }
  }

  private async openDiff(request: GitDiffRequest) {
    if (!this.sessionId) return;

    const requestId = ++this.diffRequestId;
    this.diffOpen = true;
    this.diffTitle = request.title;
    this.diffText = "";
    this.diffLoading = true;

    const diff = await fetchSessionGitDiff(this.sessionId, {
      scope: request.scope,
      path: request.path,
      sha: request.sha,
    });

    if (requestId !== this.diffRequestId) return;

    this.diffText = diff || "";
    this.diffLoading = false;
  }

  private closeDiff() {
    this.diffRequestId++;
    this.diffOpen = false;
    this.diffLoading = false;
    this.diffTitle = "";
    this.diffText = "";
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
      gitStatus: this.gitStatus,
      gitCommits: this.gitCommits,
      selectedCommitSha: this.selectedCommitSha,
      selectedCommitFiles: this.selectedCommitFiles,
      gitLoading: this.gitLoading,
      gitError: this.gitError,
      diffOpen: this.diffOpen,
      diffTitle: this.diffTitle,
      diffText: this.diffText,
      diffLoading: this.diffLoading,
      onSearchInput: (e) =>
        this.dispatchEvent(new CustomEvent("search-input", { detail: (e.target as HTMLInputElement).value })),
      onSelectFilter: (mode) =>
        this.dispatchEvent(new CustomEvent("select-filter", { detail: mode })),
      onFocusMessage: (targetId) =>
        this.dispatchEvent(new CustomEvent("focus-message", { detail: targetId })),
      onRefreshGit: () => {
        void this.refreshGitData(true);
      },
      onSelectCommit: (sha) => this.selectCommit(sha),
      onOpenDiff: (request) => {
        void this.openDiff(request);
      },
      onCloseDiff: () => this.closeDiff(),
    });
  }
}
