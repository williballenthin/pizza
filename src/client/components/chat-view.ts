import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  ThinkingLevel,
  AgentMessageData,
  ToolSpec,
  QueueDeliveryMode,
  ExtensionUIRequest,
  ImageContent,
  SessionMessageStats,
} from "@shared/types.js";
import { emptyMessageStats } from "@shared/session-stats.js";
import {
  routeInputText,
  type SubmitIntent,
} from "../utils/input-router.js";
import {
  ExtensionUiState,
  type ExtensionUiResponsePayload,
  type ExtensionStatusEntry,
  type ExtensionWidgetEntry,
} from "../utils/extension-ui-state.js";
import {
  getRenderableMessages,
  getSidebarEntries,
  type SidebarFilterMode,
  type SidebarEntry,
} from "../utils/message-shaping.js";
import {
  fetchSessionInfo,
  patchSessionName,
  unarchiveSessionIfNeeded,
} from "../utils/session-actions.js";
import { renderExtensionUiDialog } from "../utils/render-extension-ui-dialog.js";
import { renderSessionInfoStack } from "../utils/render-session-info-stack.js";
import {
  renderChatEditorFooter,
  renderAboveEditorWidgets,
  type UsageTotals,
} from "../utils/render-chat-editor-footer.js";

import {
  SessionRuntime,
  type SessionRuntimeState,
} from "../utils/session-runtime.js";

import "./session-sidebar.js";

interface SessionStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

interface InputSubmission {
  text: string;
  images?: ImageContent[];
}

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const EMPTY_SET = new Set<string>();

@customElement("chat-view")
export class ChatView extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) sessionId = "";
  @property({ type: String }) targetMessageId = "";

  @state() private runtimeState: SessionRuntimeState | null = null;
  @state() private sessionName = "Session";
  @state() private settingsOpen = false;
  @state() private renamingName = false;
  @state() private editName = "";
  @state() private showThinking = true;
  @state() private expandToolOutputs = false;
  @state() private sidebarSearch = "";
  @state() private sidebarFilter: SidebarFilterMode = "no-tools";
  @state() private sessionCreatedAt = "";
  @state() private sessionLastActivityAt = "";
  @state() private hostCwd = "";
  @state() private persistedMessageStats: SessionMessageStats = emptyMessageStats();

  @state() private extensionUiRequest: ExtensionUIRequest | null = null;
  @state() private extensionUiInput = "";
  @state() private extensionStatuses: ExtensionStatusEntry[] = [];
  @state() private extensionWidgets: ExtensionWidgetEntry[] = [];

  private extensionUiState = new ExtensionUiState();
  private runtime: SessionRuntime | null = null;
  private scrollContainer: HTMLElement | null = null;
  private shouldAutoScroll = true;
  private pendingDeepLinkTarget = "";
  private initialFocusHandled = false;

  private _lastBaseMessages: AgentMessageData[] | null = null;
  private _cachedRenderable: AgentMessageData[] = [];
  private _cachedStats: SessionStats = { userMessages: 0, assistantMessages: 0, toolCalls: 0 };
  private _cachedKnownTools: ToolSpec[] = [];
  private _cachedUsageTotals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, activeContextTokens: null, totalCost: 0 };

  private _lastSidebarRenderable: AgentMessageData[] | null = null;
  private _lastSidebarSearch = "";
  private _lastSidebarFilter: SidebarFilterMode = "no-tools";
  private _cachedSidebarEntries: SidebarEntry[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.updateDocumentTitle();
    this.pendingDeepLinkTarget = this.targetMessageId || "";
    this.bootstrapSessionRuntime();
    window.addEventListener("keydown", this.onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup();
    window.removeEventListener("keydown", this.onKeydown);
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("sessionId")) {
      const previousSessionId = changed.get("sessionId");
      if (typeof previousSessionId === "string" && previousSessionId !== this.sessionId) {
        this.resetSessionState();
        this.pendingDeepLinkTarget = this.targetMessageId || "";
        this.updateDocumentTitle();
        this.bootstrapSessionRuntime();
      } else if (!this.runtime && this.sessionId) {
        this.bootstrapSessionRuntime();
      }
    }

    if (changed.has("targetMessageId")) {
      this.pendingDeepLinkTarget = this.targetMessageId || "";
    }

    if (!this.scrollContainer) {
      this.scrollContainer = this.querySelector(".cv-messages");
      this.scrollContainer?.addEventListener("scroll", this.onScroll);
    }

    const allMessages = this.runtimeState
      ? [...this.runtimeState.baseMessages, ...this.runtimeState.streamingTail]
      : [];
    if (this.pendingDeepLinkTarget && allMessages.length) {
      this.tryApplyDeepLinkTarget(this.pendingDeepLinkTarget);
    }
  }

  private cleanup() {
    if (this.runtime) {
      this.runtime.cleanup();
      this.runtime = null;
    }
    this.scrollContainer?.removeEventListener("scroll", this.onScroll);
    this.scrollContainer = null;
  }

  private bootstrapSessionRuntime() {
    if (!this.sessionId) return;
    this.runtime = new SessionRuntime(
      this.sessionId,
      this.extensionUiState,
      (state) => {
        this.runtimeState = state;
        if (state.sessionName !== this.sessionName) {
          this.sessionName = state.sessionName;
          this.updateDocumentTitle();
        }
        this.syncExtensionUiState();
        if (this.shouldAutoScroll) {
          this.scheduleScroll();
        }
      },
    );
    this.runtime.connect();
    this.loadSessionName();
    this.focusChatInput();
  }

  private resetSessionState() {
    this.cleanup();
    this.runtimeState = null;
    this.extensionUiState.reset();
    this.syncExtensionUiState();
    this.sessionName = "Session";
    this.sessionCreatedAt = "";
    this.sessionLastActivityAt = "";
    this.hostCwd = "";
    this.persistedMessageStats = emptyMessageStats();
  }

  private syncExtensionUiState() {
    const snapshot = this.extensionUiState.snapshot();
    if (snapshot.request !== this.extensionUiRequest) this.extensionUiRequest = snapshot.request;
    if (snapshot.input !== this.extensionUiInput) this.extensionUiInput = snapshot.input;
    if (snapshot.statuses !== this.extensionStatuses) this.extensionStatuses = snapshot.statuses;
    if (snapshot.widgets !== this.extensionWidgets) this.extensionWidgets = snapshot.widgets;
  }

  private onSend(e: CustomEvent<InputSubmission>) {
    this.routeAndSubmitInput(e.detail, "send");
  }

  private onSteer(e: CustomEvent<InputSubmission>) {
    this.routeAndSubmitInput(e.detail, "steer");
  }

  private onFollowUp(e: CustomEvent<InputSubmission>) {
    this.routeAndSubmitInput(e.detail, "follow_up");
  }

  private onStop() {
    this.runtime?.send({ type: "abort" });
  }

  private routeAndSubmitInput(input: InputSubmission, intent: SubmitIntent) {
    if (!this.runtime || !this.runtimeState) return;

    const text = typeof input.text === "string" ? input.text : "";
    const images = this.normalizeImages(input.images);

    const routed = routeInputText(text, {
      intent,
      isStreaming: this.runtimeState.isStreaming,
      commands: this.runtimeState.commands,
      allowEmpty: images.length > 0,
    });

    switch (routed.kind) {
      case "none":
        return;

      case "bash":
        this.runtime.send({
          type: "bash",
          command: routed.command,
          includeInContext: routed.includeInContext,
        });
        this.shouldAutoScroll = true;
        this.scheduleScroll();
        return;

      case "prompt":
        void this.unarchiveSessionIfNeeded();
        this.runtime.appendUserMessage(routed.text, images);
        this.runtime.send({
          type: "prompt",
          text: routed.text,
          images: images.length > 0 ? images : undefined,
        });
        return;

      case "steer":
        void this.unarchiveSessionIfNeeded();
        this.runtime.appendUserMessage(routed.text, images);
        this.runtime.send({
          type: "steer",
          text: routed.text,
          images: images.length > 0 ? images : undefined,
        });
        return;

      case "follow_up":
        void this.unarchiveSessionIfNeeded();
        this.runtime.appendUserMessage(routed.text, images);
        this.runtime.send({
          type: "follow_up",
          text: routed.text,
          images: images.length > 0 ? images : undefined,
        });
        return;
    }
  }

  private normalizeImages(images: ImageContent[] | undefined): ImageContent[] {
    if (!Array.isArray(images)) return [];
    return images.filter(
      (img) =>
        !!img &&
        img.type === "image" &&
        typeof img.data === "string" &&
        img.data.length > 0 &&
        typeof img.mimeType === "string" &&
        img.mimeType.startsWith("image/"),
    );
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.extensionUiRequest) {
      e.preventDefault();
      this.cancelExtensionRequest();
    }
  };

  private onStatusModelChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    const [provider, ...rest] = value.split("/");
    const model = rest.join("/");
    this.runtime?.optimisticUpdate({ currentProvider: provider, currentModel: model });
    this.runtime?.send({ type: "set_model", provider, model });
  }

  private onStatusThinkingChange(e: Event) {
    const level = (e.target as HTMLSelectElement).value as ThinkingLevel;
    this.runtime?.optimisticUpdate({ currentThinkingLevel: level });
    this.runtime?.send({ type: "set_thinking_level", level });
  }

  private onSteeringModeChange(e: CustomEvent<QueueDeliveryMode>) {
    this.runtime?.optimisticUpdate({ currentSteeringMode: e.detail });
    this.runtime?.send({ type: "set_steering_mode", mode: e.detail });
  }

  private onFollowUpModeChange(e: CustomEvent<QueueDeliveryMode>) {
    this.runtime?.optimisticUpdate({ currentFollowUpMode: e.detail });
    this.runtime?.send({ type: "set_follow_up_mode", mode: e.detail });
  }

  private async loadSessionName() {
    const info = await fetchSessionInfo(this.sessionId);
    if (info) {
      this.sessionName = info.name;
      this.sessionCreatedAt = info.createdAt;
      this.sessionLastActivityAt = info.lastActivityAt;
      this.persistedMessageStats = info.messageStats;
      if (info.cwd) this.hostCwd = info.cwd;
      this.updateDocumentTitle();
    }
  }

  private async unarchiveSessionIfNeeded() {
    const nextName = await unarchiveSessionIfNeeded(this.sessionId, this.sessionName);
    if (nextName) {
      this.sessionName = nextName;
      this.updateDocumentTitle();
    }
  }

  private updateDocumentTitle() {
    const title = this.sessionName.trim();
    if (!title || title === "Session") {
      document.title = "pizza";
      return;
    }
    document.title = title;
  }

  private startRename() {
    this.editName = this.sessionName;
    this.renamingName = true;
    this.updateComplete.then(() => {
      const input = this.querySelector(".cv-title-input") as HTMLInputElement;
      input?.focus();
      input?.select();
    });
  }

  private async commitRename() {
    this.renamingName = false;
    const name = this.editName.trim();
    if (!name || name === this.sessionName) return;
    const success = await patchSessionName(this.sessionId, name);
    if (success) {
      this.sessionName = name;
      this.updateDocumentTitle();
    }
  }

  private onTitleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.commitRename();
    } else if (e.key === "Escape") {
      this.renamingName = false;
    }
  }

  private onScroll = () => {
    const el = this.scrollContainer;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.shouldAutoScroll = distFromBottom < 80;
  };

  private scheduleScroll() {
    if (!this.shouldAutoScroll) return;
    requestAnimationFrame(() => {
      if (this.scrollContainer) {
        this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
      }
    });
  }

  private scrollToMessage(targetId: string, smooth = true) {
    if (!targetId) return;
    const target = this.querySelector(`#${targetId}`) as HTMLElement | null;
    if (!target) return;

    this.shouldAutoScroll = false;
    target.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "center",
    });

    target.classList.add("highlight");
    setTimeout(() => target.classList.remove("highlight"), 2000);
  }

  private tryApplyDeepLinkTarget(targetId: string) {
    const target = this.querySelector(`#${targetId}`);
    if (!target) return;
    this.pendingDeepLinkTarget = "";
    this.scrollToMessage(targetId, false);
  }

  private focusMessage(targetId: string) {
    const nextHash = `#/session/${encodeURIComponent(this.sessionId)}?target=${encodeURIComponent(targetId)}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
    this.scrollToMessage(targetId);
  }

  private focusChatInput() {
    this.updateComplete.then(() => {
      const input = this.querySelector("chat-input") as (HTMLElement & { focusInput?: () => void }) | null;
      input?.focusInput?.();
    });
  }

  private onExtensionInput = (e: InputEvent) => {
    this.extensionUiState.setInput((e.target as HTMLTextAreaElement).value);
    this.syncExtensionUiState();
  };

  private sendExtensionUiResponse(payload: ExtensionUiResponsePayload) {
    this.runtime?.send({
      type: "extension_ui_response",
      ...payload
    } as any);
  }

  private respondExtensionWithValue(value: string) {
    const payload = this.extensionUiState.respondWithValue(value);
    if (!payload) return;
    this.sendExtensionUiResponse(payload);
    this.syncExtensionUiState();
  }

  private respondExtensionWithConfirm(confirmed: boolean) {
    const payload = this.extensionUiState.respondWithConfirm(confirmed);
    if (!payload) return;
    this.sendExtensionUiResponse(payload);
    this.syncExtensionUiState();
  }

  private cancelExtensionRequest() {
    const payload = this.extensionUiState.cancelCurrent();
    if (!payload) return;
    this.sendExtensionUiResponse(payload);
    this.syncExtensionUiState();
  }

  private getRenderableMessages(): AgentMessageData[] {
    return getRenderableMessages(this.runtimeState?.baseMessages || []);
  }

  private getSidebarEntries(renderable: AgentMessageData[]): SidebarEntry[] {
    return getSidebarEntries(renderable, this.sidebarSearch, this.sidebarFilter);
  }

  private computeStats(renderable: AgentMessageData[]): SessionStats {
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;

    for (const msg of renderable) {
      if (msg.role === "user" || msg.role === "user-with-attachments") {
        userMessages++;
      } else if (msg.role === "assistant") {
        assistantMessages++;
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && typeof part === "object" && (part as any).type === "toolCall") {
              toolCalls++;
            }
          }
        }
      }
    }
    return { userMessages, assistantMessages, toolCalls };
  }

  private getKnownToolSpecs(renderable: AgentMessageData[]): ToolSpec[] {
    const builtins: ToolSpec[] = [
      { name: "read", description: "Read file contents", parameters: { properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "edit", description: "Replace exact text", parameters: { properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } },
      { name: "write", description: "Write content to a file", parameters: { properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "bash", description: "Execute a shell command", parameters: { properties: { command: { type: "string" } }, required: ["command"] } },
    ];
    const byName = new Map<string, ToolSpec>();
    for (const tool of [...builtins, ...(this.runtimeState?.tools || [])]) {
      if (tool?.name) byName.set(tool.name, tool);
    }
    for (const msg of renderable) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object" && (part as any).type === "toolCall") {
            const name = (part as any).name;
            if (typeof name === "string" && !byName.has(name)) byName.set(name, { name, description: "Custom tool" });
          }
        }
      }
      if (msg.role === "toolResult") {
        const name = (msg as any).toolName;
        if (typeof name === "string" && name && !byName.has(name)) byName.set(name, { name, description: "Custom tool" });
      }
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private computeUsageTotals(messages: AgentMessageData[]): UsageTotals {
    const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, activeContextTokens: null, totalCost: 0 };
    let lastAssistantUsage: any = null;
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.usage) continue;
      const u = msg.usage as any;
      totals.input += u.input || u.inputTokens || u.promptTokens || 0;
      totals.output += u.output || u.outputTokens || u.completionTokens || 0;
      totals.cacheRead += u.cacheRead || u.cachedRead || 0;
      totals.cacheWrite += u.cacheWrite || u.cachedWrite || 0;
      // Track last assistant usage for context tokens calculation
      // Skip aborted/error messages as they don't have valid usage data
      const stopReason = (msg as any).stopReason;
      if (stopReason !== "aborted" && stopReason !== "error") {
        lastAssistantUsage = u;
      }
      if (u.cost?.total) totals.totalCost += u.cost.total;
    }
    // Calculate active context tokens from the last assistant message's usage
    // This matches pi's calculateContextTokens function
    if (lastAssistantUsage) {
      totals.activeContextTokens = lastAssistantUsage.totalTokens ||
        (lastAssistantUsage.input || 0) + (lastAssistantUsage.output || 0) +
        (lastAssistantUsage.cacheRead || 0) + (lastAssistantUsage.cacheWrite || 0);
    }
    return totals;
  }

  private formatDateTime(iso: string): string {
    if (!iso) return "unknown";
    const date = new Date(iso);
    return isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  private renderExtensionUiDialog() {
    return renderExtensionUiDialog({
      request: this.extensionUiRequest,
      input: this.extensionUiInput,
      onInput: this.onExtensionInput,
      onCancel: () => this.cancelExtensionRequest(),
      onConfirm: (confirmed) => this.respondExtensionWithConfirm(confirmed),
      onValue: (value) => this.respondExtensionWithValue(value),
    });
  }

  render() {
    const rs = this.runtimeState;
    const baseMessages = rs?.baseMessages || [];
    const streamingTail = rs?.streamingTail || [];

    if (baseMessages !== this._lastBaseMessages) {
      this._lastBaseMessages = baseMessages;
      this._cachedRenderable = this.getRenderableMessages();
      this._cachedStats = this.computeStats(this._cachedRenderable);
      this._cachedKnownTools = this.getKnownToolSpecs(this._cachedRenderable);
      this._cachedUsageTotals = this.computeUsageTotals(baseMessages);
    }
    const renderableMessages = this._cachedRenderable;
    const stats = this._cachedStats;
    const knownTools = this._cachedKnownTools;
    const usageTotals = this._cachedUsageTotals;

    if (
      renderableMessages !== this._lastSidebarRenderable ||
      this.sidebarSearch !== this._lastSidebarSearch ||
      this.sidebarFilter !== this._lastSidebarFilter
    ) {
      this._lastSidebarRenderable = renderableMessages;
      this._lastSidebarSearch = this.sidebarSearch;
      this._lastSidebarFilter = this.sidebarFilter;
      this._cachedSidebarEntries = this.getSidebarEntries(renderableMessages);
    }
    const sidebarEntries = this._cachedSidebarEntries;
    const createdAtLabel = this.formatDateTime(this.sessionCreatedAt);
    const lastActivityAtLabel = this.formatDateTime(this.sessionLastActivityAt);
    const modelLabel = rs?.currentProvider ? `${rs.currentProvider}/${rs.currentModel}` : (rs?.currentModel || "unknown");

    const allMessages = streamingTail.length > 0
      ? [...baseMessages, ...streamingTail]
      : baseMessages;
    const allRenderable = streamingTail.length > 0
      ? [...renderableMessages, ...getRenderableMessages(streamingTail)]
      : renderableMessages;

    const isStreaming = rs?.isStreaming ?? false;
    const isAgentWorking = rs?.isAgentWorking ?? false;
    const connected = rs?.connected ?? false;
    const reconnecting = rs?.reconnecting ?? false;
    const error = rs?.error ?? "";

    return html`
      <button class="cv-gear-btn cv-floating-gear-btn" @click=${() => (this.settingsOpen = true)} title="Settings">&#9881;</button>

      ${reconnecting ? html`<div class="cv-banner reconnecting">Connection lost. Reconnecting&hellip;</div>` : nothing}
      ${connected && rs?.modelsLoaded && !rs?.currentModel
        ? html`<div class="cv-banner warning">No model available. Configure an API key or model provider in pi.</div>`
        : error ? html`<div class="cv-banner error">${error}</div>` : nothing}

      <div class="cv-body">
        <session-sidebar
          .sessionId=${this.sessionId}
          .sidebarSearch=${this.sidebarSearch}
          .sidebarFilter=${this.sidebarFilter}
          .entries=${sidebarEntries}
          @search-input=${(e: CustomEvent<string>) => (this.sidebarSearch = e.detail)}
          @select-filter=${(e: CustomEvent<SidebarFilterMode>) => (this.sidebarFilter = e.detail)}
          @focus-message=${(e: CustomEvent<string>) => this.focusMessage(e.detail)}
        ></session-sidebar>

        <div class="cv-main-col">
          <a class="cv-back-btn" href="#/" title="Back to session list">&#8592;</a>
          <div class="cv-messages">
            ${renderSessionInfoStack({
              sessionId: this.sessionId,
              sessionName: this.sessionName,
              renamingName: this.renamingName,
              editName: this.editName,
              createdAtLabel,
              lastActivityAtLabel,
              modelLabel,
              thinkingLevel: rs?.currentThinkingLevel || "off",
              stats,
              persistedMessageStats: this.persistedMessageStats,
              usage: usageTotals,
              currentContextWindow: rs?.currentContextWindow || null,
              contextMessageCount: allRenderable.length,
              systemPrompt: rs?.systemPrompt || "",
              knownTools,
              onStartRename: () => this.startRename(),
              onEditNameInput: (e: InputEvent) => (this.editName = (e.target as HTMLInputElement).value),
              onTitleKeydown: (e: KeyboardEvent) => this.onTitleKeydown(e),
              onCommitRename: () => this.commitRename(),
            })}

            <message-list
              .messages=${allRenderable}
              .allMessages=${allMessages}
              .isStreaming=${isStreaming}
              .pendingToolCalls=${rs?.pendingToolCalls || EMPTY_SET}
              .showThinking=${this.showThinking}
              .expandToolOutputs=${this.expandToolOutputs}
            ></message-list>

            ${isAgentWorking
              ? html`
                  <div class="cv-agent-working">
                    <div class="cv-agent-spinner" title="Agent working"></div>
                    <button class="cv-agent-stop-btn" @click=${this.onStop} title="Stop">
                      &#9632;
                    </button>
                  </div>
                `
              : nothing}
            ${rs?.wasInterrupted && !isStreaming ? html`<div class="cv-interrupted">Interrupted</div>` : nothing}
          </div>

          ${renderAboveEditorWidgets(this.extensionWidgets)}

          <chat-input
            .isStreaming=${isStreaming}
            .disabled=${(rs?.models.length || 0) > 0 && !rs?.currentModel}
            .commands=${rs?.commands || []}
            .commandsLoading=${rs?.commandsLoading || false}
            @send=${this.onSend}
            @steer=${this.onSteer}
            @follow-up=${this.onFollowUp}
          ></chat-input>

          ${renderChatEditorFooter({
            usage: usageTotals,
            hostCwd: this.hostCwd,
            hostGitBranch: "",
            reconnecting,
            connected,
            isStreaming,
            currentContextWindow: rs?.currentContextWindow || null,
            autoCompactionEnabled: rs?.autoCompactionEnabled || false,
            persistedMessageCount: this.persistedMessageStats.totalMessages,
            pendingMessageCount: rs?.pendingMessageCount || 0,
            extensionStatuses: this.extensionStatuses,
            extensionWidgets: this.extensionWidgets,
            models: rs?.models || [],
            currentProvider: rs?.currentProvider || "",
            currentModel: rs?.currentModel || "",
            currentThinkingLevel: rs?.currentThinkingLevel || "",
            thinkingLevels: THINKING_LEVELS,
            onModelChange: (e) => this.onStatusModelChange(e),
            onThinkingChange: (e) => this.onStatusThinkingChange(e),
          })}
        </div>
      </div>

      ${this.renderExtensionUiDialog()}

      <settings-panel
        .open=${this.settingsOpen}
        .sessionId=${this.sessionId}
        .sessionName=${this.sessionName}
        .currentSteeringMode=${rs?.currentSteeringMode || "one-at-a-time"}
        .currentFollowUpMode=${rs?.currentFollowUpMode || "one-at-a-time"}
        .showThinking=${this.showThinking}
        .expandToolOutputs=${this.expandToolOutputs}
        @close=${() => (this.settingsOpen = false)}
        @steering-mode-change=${this.onSteeringModeChange}
        @follow-up-mode-change=${this.onFollowUpModeChange}
        @show-thinking-change=${(e: CustomEvent<boolean>) =>
          (this.showThinking = e.detail)}
        @expand-tool-outputs-change=${(e: CustomEvent<boolean>) =>
          (this.expandToolOutputs = e.detail)}
        @archive=${this.onArchive}
      ></settings-panel>
    `;
  }

  private onArchive() {
    window.location.hash = "#/";
  }
}
