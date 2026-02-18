import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  ClientMessage,
  ServerMessage,
  ModelInfo,
  ThinkingLevel,
  AgentMessageData,
  ToolSpec,
  SlashCommandSpec,
  QueueDeliveryMode,
  ExtensionUIRequest,
  ShellResultMessage,
} from "@shared/types.js";
import {
  routeInputText,
  parseSlashCommandName,
  type SubmitIntent,
} from "../utils/input-router.js";
import {
  isArchivedSessionName,
  unarchiveSessionName,
} from "@shared/session-archive.js";

/* ------------------------------------------------------------------ */
/*  Lightweight interfaces for the streaming assistant message we      */
/*  build locally. These mirror pi-ai content-block shapes.            */
/* ------------------------------------------------------------------ */

interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

interface PartialAssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  timestamp: number;
  stopReason?: string;
}

type SidebarFilterMode = "default" | "no-tools" | "user-only" | "all";

interface SidebarEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  targetId: string;
}

interface SessionStats {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  toolCalls: number;
  totalVisible: number;
}

@customElement("chat-view")
export class ChatView extends LitElement {
  // ---- Light DOM so global theme styles apply to message markup ----
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) sessionId = "";
  @property({ type: String }) targetMessageId = "";

  @state() private messages: AgentMessageData[] = [];
  @state() private isStreaming = false;
  @state() private currentModel = "";
  @state() private currentProvider = "";
  @state() private currentThinkingLevel: ThinkingLevel = "off";
  @state() private currentSteeringMode: QueueDeliveryMode = "one-at-a-time";
  @state() private currentFollowUpMode: QueueDeliveryMode = "one-at-a-time";
  @state() private models: ModelInfo[] = [];
  @state() private commands: SlashCommandSpec[] = [];
  @state() private commandsLoading = false;
  @state() private settingsOpen = false;
  @state() private sessionName = "Session";
  @state() private connected = false;
  @state() private reconnecting = false;
  @state() private error = "";
  @state() private modelsLoaded = false;
  @state() private renamingName = false;
  @state() private editName = "";
  @state() private wasInterrupted = false;
  @state() private showThinking = true;
  @state() private expandToolOutputs = false;
  @state() private sidebarSearch = "";
  @state() private sidebarFilter: SidebarFilterMode = "default";
  @state() private sessionCreatedAt = "";
  @state() private sessionLastActivityAt = "";
  @state() private persistedMessageCount = 0;
  @state() private pendingMessageCount = 0;
  @state() private systemPrompt = "";
  @state() private tools: ToolSpec[] = [];
  @state() private extensionUiRequest: ExtensionUIRequest | null = null;
  @state() private extensionUiInput = "";
  @state() private extensionStatuses: Array<{ key: string; text: string }> = [];
  @state()
  private extensionWidgets: Array<{
    key: string;
    lines: string[];
    placement: "aboveEditor" | "belowEditor";
  }> = [];
  @state()
  private extensionNotifications: Array<{
    id: string;
    message: string;
    notifyType: "info" | "warning" | "error";
  }> = [];

  // Pending tool calls for local MessageList
  private pendingToolCalls = new Set<string>();

  // Interactive extension UI requests are serialized for predictable UX.
  private pendingExtensionUiRequests: ExtensionUIRequest[] = [];

  // Partial tool results accumulated from tool_execution_update events.
  // These are injected into the messages array so MessageList can show
  // streaming tool output before the tool finishes.
  private partialToolResults = new Map<string, AgentMessageData>();

  // The assistant message we're building during streaming
  private streamMsg: PartialAssistantMessage | null = null;

  // WebSocket
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Auto-scroll
  private shouldAutoScroll = true;
  private scrollContainer: HTMLElement | null = null;

  // Batched streaming render
  private streamUpdatePending = false;

  // ---- Lifecycle ----

  connectedCallback() {
    super.connectedCallback();
    this.updateDocumentTitle();
    this.pendingDeepLinkTarget = this.targetMessageId || "";
    this.connect();
    this.loadSessionName();
    this.focusChatInput();
    window.addEventListener("keydown", this.onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup();
    window.removeEventListener("keydown", this.onKeydown);
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("sessionId") && changed.get("sessionId") !== undefined) {
      this.cleanup();
      this.messages = [];
      this.streamMsg = null;
      this.wasInterrupted = false;
      this.systemPrompt = "";
      this.tools = [];
      this.commands = [];
      this.commandsLoading = false;
      this.currentSteeringMode = "one-at-a-time";
      this.currentFollowUpMode = "one-at-a-time";
      this.extensionUiRequest = null;
      this.extensionUiInput = "";
      this.pendingExtensionUiRequests = [];
      this.extensionStatuses = [];
      this.extensionWidgets = [];
      this.extensionNotifications = [];
      this.sessionName = "Session";
      this.sessionCreatedAt = "";
      this.sessionLastActivityAt = "";
      this.pendingDeepLinkTarget = this.targetMessageId || "";
      this.updateDocumentTitle();
      this.connect();
      this.loadSessionName();
      this.focusChatInput();
    }

    if (changed.has("sessionName")) {
      this.updateDocumentTitle();
    }

    if (changed.has("targetMessageId")) {
      this.pendingDeepLinkTarget = this.targetMessageId || "";
    }

    // Grab scroll container ref after render
    if (!this.scrollContainer) {
      this.scrollContainer = this.querySelector(".cv-messages");
      this.scrollContainer?.addEventListener("scroll", this.onScroll);
    }

    if (
      this.pendingDeepLinkTarget &&
      (changed.has("messages") || changed.has("targetMessageId"))
    ) {
      this.tryApplyDeepLinkTarget(this.pendingDeepLinkTarget);
    }
  }

  // ---- WebSocket ----

  private connect() {
    if (this.ws) this.cleanup();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/sessions/${this.sessionId}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnecting = false;
      this.reconnectAttempt = 0;
      this.error = "";
      this.wsSend({ type: "get_available_models" });
      this.requestCommands(true);
    };

    this.ws.onmessage = (ev) => {
      this.handleServerMessage(JSON.parse(ev.data) as ServerMessage);
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.connected = false;
    };
  }

  private cleanup() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.scrollContainer?.removeEventListener("scroll", this.onScroll);
    this.scrollContainer = null;
  }

  private scheduleReconnect() {
    this.reconnecting = true;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private wsSend(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private requestCommands(force = false) {
    if (!force && (this.commandsLoading || this.commands.length > 0)) return;
    this.commandsLoading = true;
    this.wsSend({ type: "get_commands" });
  }

  // ---- Message handling ----

  private handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "state":
        this.partialToolResults.clear();
        this.messages = msg.messages || [];
        this.isStreaming = msg.isStreaming;
        if (msg.model) {
          this.currentProvider = msg.model.provider;
          this.currentModel = msg.model.id;
        } else {
          this.currentProvider = "";
          this.currentModel = "";
        }
        this.currentThinkingLevel =
          (msg.thinkingLevel as ThinkingLevel) || "off";
        if (msg.steeringMode) {
          this.currentSteeringMode = msg.steeringMode;
        }
        if (msg.followUpMode) {
          this.currentFollowUpMode = msg.followUpMode;
        }
        this.persistedMessageCount = msg.messageCount || 0;
        this.pendingMessageCount = msg.pendingMessageCount || 0;
        if (typeof msg.systemPrompt === "string") {
          this.systemPrompt = msg.systemPrompt;
        }
        if (Array.isArray(msg.tools) && msg.tools.length > 0) {
          this.tools = msg.tools;
        }
        this.scheduleScroll();
        break;

      case "agent_event":
        this.handleAgentEvent(msg.event);
        break;

      case "available_models":
        this.models = msg.models;
        this.modelsLoaded = true;
        break;

      case "available_commands":
        this.commands = msg.commands;
        this.commandsLoading = false;
        break;

      case "shell_result":
        this.handleShellResult(msg);
        break;

      case "error":
        this.error = msg.message;
        this.commandsLoading = false;
        break;
    }
  }

  private handleAgentEvent(event: { type: string; [key: string]: unknown }) {
    switch (event.type) {
      case "agent_start":
        this.isStreaming = true;
        this.wasInterrupted = false;
        break;

      case "agent_end":
        this.finalizeStreaming();
        this.isStreaming = false;
        break;

      case "message_start":
        // Start accumulating a new assistant message
        this.streamMsg = {
          role: "assistant",
          content: [],
          timestamp: Date.now(),
        };
        break;

      case "message_update": {
        if (!this.streamMsg) break;
        const sub = event.assistantMessageEvent as
          | { type: string; delta?: string; contentIndex?: number; toolCall?: ToolCallBlock }
          | undefined;
        if (!sub) break;

        if (sub.type === "text_delta" && sub.delta) {
          const last =
            this.streamMsg.content[this.streamMsg.content.length - 1];
          if (last?.type === "text") {
            (last as TextBlock).text += sub.delta;
          } else {
            this.streamMsg.content.push({
              type: "text",
              text: sub.delta,
            });
          }
          this.scheduleStreamUpdate();
        } else if (sub.type === "thinking_delta" && sub.delta) {
          const last =
            this.streamMsg.content[this.streamMsg.content.length - 1];
          if (last?.type === "thinking") {
            (last as ThinkingBlock).thinking += sub.delta;
          } else {
            this.streamMsg.content.push({
              type: "thinking",
              thinking: sub.delta,
            });
          }
          this.scheduleStreamUpdate();
        } else if (sub.type === "toolcall_end" && sub.toolCall) {
          const tc = sub.toolCall;
          this.streamMsg.content.push({
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments || {},
          });
          this.pendingToolCalls.add(tc.id);
          this.scheduleStreamUpdate();
        }
        break;
      }

      case "message_end":
        this.finalizeStreaming();
        break;

      case "tool_execution_start": {
        const id = event.toolCallId as string | undefined;
        if (id) this.pendingToolCalls.add(id);
        break;
      }

      case "tool_execution_update": {
        const id = event.toolCallId as string | undefined;
        if (!id) break;

        // Build or update a partial tool result from the event's content/output
        const content = event.content as
          | Array<{ type: string; text?: string }>
          | undefined;
        const output = event.output as unknown;

        const outputText =
          typeof output === "string"
            ? output
            : output === undefined || output === null
              ? ""
              : JSON.stringify(output, null, 2);

        if (content || output !== undefined) {
          const resultContent = content || [{ type: "text", text: outputText }];
          this.partialToolResults.set(id, {
            role: "toolResult",
            toolCallId: id,
            toolName: (event.toolName as string) || "",
            content: resultContent,
            output,
            details: event.details,
            isError: Boolean(event.isError),
            timestamp: Date.now(),
          } as AgentMessageData);
          this.scheduleStreamUpdate();
        }
        break;
      }

      case "tool_execution_end": {
        const id = event.toolCallId as string | undefined;
        if (id) {
          this.pendingToolCalls.delete(id);
          this.partialToolResults.delete(id);
        }
        break;
      }

      case "response": {
        const data = event.data as
          | { messages?: AgentMessageData[] }
          | undefined;
        if (data?.messages) {
          this.partialToolResults.clear();
          this.messages = data.messages;
          this.scheduleScroll();
        }
        break;
      }

      case "extension_ui_request":
        this.handleExtensionUIRequest(event as ExtensionUIRequest);
        break;

      case "turn_end":
        this.wsSend({ type: "get_state" });
        break;
    }
  }

  private finalizeStreaming() {
    if (this.streamMsg && this.streamMsg.content.length > 0) {
      this.partialToolResults.clear();
      this.messages = [
        ...this.messages.filter(
          (m) => !(m as Record<string, unknown>)._partialToolResult,
        ),
        this.streamMsg as unknown as AgentMessageData,
      ];
      this.streamMsg = null;
      this.scheduleScroll();
    }
  }

  /** Batch streaming UI updates to avoid excessive renders. */
  private scheduleStreamUpdate() {
    if (this.streamUpdatePending) return;
    this.streamUpdatePending = true;
    requestAnimationFrame(() => {
      this.streamUpdatePending = false;
      // Trigger Lit re-render by creating new messages array ref
      // with a deep-cloned streaming message appended, plus any
      // partial tool results so MessageList can show live output.
      const base = this.messages.filter(
        (m) =>
          m !== this._lastStreamClone &&
          !(m as Record<string, unknown>)._partialToolResult,
      );

      // Append partial tool results so MessageList can pair a toolCall
      // block with its current/partial result by toolCallId.
      for (const partial of this.partialToolResults.values()) {
        const tagged = { ...partial, _partialToolResult: true };
        base.push(tagged as AgentMessageData);
      }

      if (this.streamMsg) {
        const clone = JSON.parse(
          JSON.stringify(this.streamMsg),
        ) as AgentMessageData;
        base.push(clone);
        this._lastStreamClone = clone;
      }

      this.messages = base;
      this.scheduleScroll();
    });
  }

  private handleShellResult(result: ShellResultMessage) {
    const shellMessage: AgentMessageData = {
      role: "bashExecution",
      command: result.command,
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      fullOutputPath: result.fullOutputPath,
      excludeFromContext: !result.includeInContext,
      timestamp: result.timestamp,
    };

    this.messages = [...this.messages, shellMessage];
    this.shouldAutoScroll = true;
    this.scheduleScroll();
  }

  private handleExtensionUIRequest(request: ExtensionUIRequest) {
    switch (request.method) {
      case "notify": {
        this.pushExtensionNotification(
          request.message,
          request.notifyType || "info",
        );
        return;
      }

      case "setStatus": {
        const text = request.statusText || "";
        const rest = this.extensionStatuses.filter(
          (s) => s.key !== request.statusKey,
        );
        this.extensionStatuses = text
          ? [...rest, { key: request.statusKey, text }]
          : rest;
        return;
      }

      case "setWidget": {
        const lines = request.widgetLines || [];
        const placement = request.widgetPlacement || "belowEditor";
        const rest = this.extensionWidgets.filter(
          (w) => w.key !== request.widgetKey,
        );
        this.extensionWidgets = lines.length
          ? [...rest, { key: request.widgetKey, lines, placement }]
          : rest;
        return;
      }

      case "setTitle": {
        this.sessionName = request.title || this.sessionName;
        return;
      }

      case "set_editor_text": {
        const input = this.querySelector("chat-input") as
          | (HTMLElement & { setText?: (value: string) => void })
          | null;
        input?.setText?.(request.text || "");
        return;
      }

      default:
        break;
    }

    if (!this.extensionUiRequest) {
      this.openExtensionRequest(request);
      return;
    }

    this.pendingExtensionUiRequests.push(request);
  }

  private openExtensionRequest(request: ExtensionUIRequest) {
    this.extensionUiRequest = request;

    if (
      request.method === "input" ||
      request.method === "editor" ||
      request.method === "select"
    ) {
      if (request.method === "editor") {
        this.extensionUiInput = request.prefill || "";
      } else if (request.method === "input") {
        this.extensionUiInput = "";
      } else {
        this.extensionUiInput = request.options[0] || "";
      }
    } else {
      this.extensionUiInput = "";
    }
  }

  private dequeueExtensionRequest() {
    if (this.pendingExtensionUiRequests.length === 0) {
      this.extensionUiRequest = null;
      this.extensionUiInput = "";
      return;
    }

    const next = this.pendingExtensionUiRequests.shift();
    if (next) {
      this.openExtensionRequest(next);
    }
  }

  private respondExtensionWithValue(value: string) {
    const current = this.extensionUiRequest;
    if (!current) return;

    this.wsSend({ type: "extension_ui_response", id: current.id, value });
    this.dequeueExtensionRequest();
  }

  private respondExtensionWithConfirm(confirmed: boolean) {
    const current = this.extensionUiRequest;
    if (!current) return;

    this.wsSend({
      type: "extension_ui_response",
      id: current.id,
      confirmed,
    });
    this.dequeueExtensionRequest();
  }

  private cancelExtensionRequest() {
    const current = this.extensionUiRequest;
    if (!current) return;

    this.wsSend({ type: "extension_ui_response", id: current.id, cancelled: true });
    this.dequeueExtensionRequest();
  }

  private pushExtensionNotification(
    message: string,
    notifyType: "info" | "warning" | "error",
  ) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.extensionNotifications = [
      ...this.extensionNotifications,
      { id, message, notifyType },
    ];

    setTimeout(() => {
      this.extensionNotifications = this.extensionNotifications.filter(
        (note) => note.id !== id,
      );
    }, 6000);
  }

  private _lastStreamClone: AgentMessageData | null = null;
  private pendingDeepLinkTarget = "";

  // ---- Auto-scroll ----

  private onScroll = () => {
    const el = this.scrollContainer;
    if (!el) return;
    // If user scrolled up more than 80px from bottom, pause auto-scroll
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.shouldAutoScroll = distFromBottom < 80;
  };

  private scrollRequestPending = false;

  private scheduleScroll() {
    if (!this.shouldAutoScroll || this.scrollRequestPending) return;
    this.scrollRequestPending = true;
    requestAnimationFrame(() => {
      this.scrollRequestPending = false;
      if (this.scrollContainer) {
        this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
      }
    });
  }

  private focusChatInput() {
    this.updateComplete.then(() => {
      const input = this.querySelector("chat-input") as
        | (HTMLElement & { focusInput?: () => void })
        | null;
      input?.focusInput?.();
    });
  }

  // ---- User actions ----

  private onSend(e: CustomEvent<string>) {
    this.routeAndSubmitText(e.detail, "send");
  }

  private onSteer(e: CustomEvent<string>) {
    this.routeAndSubmitText(e.detail, "steer");
  }

  private onFollowUp(e: CustomEvent<string>) {
    this.routeAndSubmitText(e.detail, "follow_up");
  }

  private routeAndSubmitText(text: string, intent: SubmitIntent) {
    const slashName = parseSlashCommandName(text);
    if (slashName && this.commands.length === 0 && !this.commandsLoading) {
      this.requestCommands(true);
    }

    if (
      slashName &&
      this.commands.length > 0 &&
      !this.commands.some((cmd) => cmd.name === slashName)
    ) {
      this.pushExtensionNotification(
        `Unknown slash command '/${slashName}'. Built-in TUI commands are not available over RPC; use listed extension/prompt/skill commands.`,
        "warning",
      );
    }

    const routed = routeInputText(text, {
      intent,
      isStreaming: this.isStreaming,
      commands: this.commands,
    });

    switch (routed.kind) {
      case "none":
        return;

      case "local_command":
        // Reserved for local client-side slash commands, currently unused.
        return;

      case "bash":
        this._lastStreamClone = null;
        this.shouldAutoScroll = true;
        this.wsSend({
          type: "bash",
          command: routed.command,
          includeInContext: routed.includeInContext,
        });
        this.scheduleScroll();
        return;

      case "prompt":
        void this.unarchiveSessionIfNeeded();
        this.appendUserMessage(routed.text);
        this.wsSend({ type: "prompt", text: routed.text });
        return;

      case "steer":
        void this.unarchiveSessionIfNeeded();
        this.wasInterrupted = true;
        this.finalizeStreaming();
        this.appendUserMessage(routed.text);
        this.wsSend({ type: "steer", text: routed.text });
        return;

      case "follow_up":
        void this.unarchiveSessionIfNeeded();
        this.appendUserMessage(routed.text);
        this.wsSend({ type: "follow_up", text: routed.text });
        return;
    }
  }

  private appendUserMessage(text: string) {
    this.messages = [
      ...this.messages,
      { role: "user", content: text, timestamp: Date.now() } as AgentMessageData,
    ];
    this._lastStreamClone = null;
    this.shouldAutoScroll = true;
    this.scheduleScroll();
  }

  private onStop() {
    this.wasInterrupted = true;
    this.wsSend({ type: "abort" });
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.extensionUiRequest) {
      e.preventDefault();
      this.cancelExtensionRequest();
      return;
    }

    if (e.ctrlKey && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      this.showThinking = !this.showThinking;
      return;
    }

    if (e.ctrlKey && (e.key === "o" || e.key === "O")) {
      e.preventDefault();
      this.expandToolOutputs = !this.expandToolOutputs;
    }
  };

  private onModelChange(e: CustomEvent<{ provider: string; model: string }>) {
    const { provider, model } = e.detail;
    this.currentProvider = provider;
    this.currentModel = model;
    this.wsSend({ type: "set_model", provider, model });
  }

  private onThinkingChange(e: CustomEvent<ThinkingLevel>) {
    this.currentThinkingLevel = e.detail;
    this.wsSend({ type: "set_thinking_level", level: e.detail });
  }

  private onSteeringModeChange(e: CustomEvent<QueueDeliveryMode>) {
    this.currentSteeringMode = e.detail;
    this.wsSend({ type: "set_steering_mode", mode: e.detail });
  }

  private onFollowUpModeChange(e: CustomEvent<QueueDeliveryMode>) {
    this.currentFollowUpMode = e.detail;
    this.wsSend({ type: "set_follow_up_mode", mode: e.detail });
  }

  // ---- Session name ----

  private updateDocumentTitle() {
    const title = this.sessionName.trim();
    if (!title || title === "Session") {
      document.title = "pizza";
      return;
    }
    document.title = title;
  }

  private async loadSessionName() {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = await res.json();
      const session = data.sessions.find(
        (s: {
          id: string;
          name: string;
          createdAt?: string;
          lastActivityAt?: string;
          messageCount?: number;
        }) => s.id === this.sessionId,
      );
      if (session) {
        this.sessionName = session.name;
        this.sessionCreatedAt = session.createdAt || "";
        this.sessionLastActivityAt = session.lastActivityAt || "";
        this.persistedMessageCount = session.messageCount || 0;
      }
    } catch {
      // ignore
    }
  }

  private async unarchiveSessionIfNeeded() {
    if (!isArchivedSessionName(this.sessionName)) return;

    const nextName = unarchiveSessionName(this.sessionName).trim() || "Session";
    this.sessionName = nextName;

    try {
      await fetch(`/api/sessions/${this.sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName }),
      });
    } catch {
      // ignore
    }
  }

  private startRename() {
    this.editName = this.sessionName;
    this.renamingName = true;
    this.updateComplete.then(() => {
      const input = this.querySelector(
        ".cv-title-input",
      ) as HTMLInputElement;
      input?.focus();
      input?.select();
    });
  }

  private async commitRename() {
    this.renamingName = false;
    const name = this.editName.trim();
    if (!name || name === this.sessionName) return;
    this.sessionName = name;
    try {
      await fetch(`/api/sessions/${this.sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch {
      // ignore
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

  private getRenderableMessages(): AgentMessageData[] {
    const toolCallIds = new Set<string>();

    for (const message of this.messages) {
      if (message.role === "system" && !this.systemPrompt) {
        const text = this.extractPromptText(message.content);
        if (text) this.systemPrompt = text;
      }

      if (message.role !== "assistant") continue;
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (
          part &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "toolCall"
        ) {
          const id = (part as Record<string, unknown>).id;
          if (typeof id === "string") toolCallIds.add(id);
        }
      }
    }

    return this.messages.filter((message) => {
      if (message.role === "artifact" || message.role === "system") return false;
      if (
        message.role === "toolResult" &&
        typeof message.toolCallId === "string" &&
        toolCallIds.has(message.toolCallId)
      ) {
        return false;
      }
      return true;
    });
  }

  private getSidebarEntries(renderable: AgentMessageData[]): SidebarEntry[] {
    const query = this.sidebarSearch.trim().toLowerCase();

    const entries = renderable
      .map((message, renderIndex): SidebarEntry | null => {
        const targetId = this.messageDomId(renderIndex);

        if (message.role === "user" || message.role === "user-with-attachments") {
          return {
            role: "user",
            text: this.extractPreviewText(message.content),
            targetId,
          };
        }

        if (message.role === "assistant") {
          const text = this.extractPreviewText(message.content) || "(no text)";
          return {
            role: "assistant",
            text,
            targetId,
          };
        }

        if (message.role === "toolResult") {
          const toolName =
            typeof message.toolName === "string" && message.toolName
              ? message.toolName
              : "tool";
          const output = this.extractPreviewText(message.content);
          return {
            role: "tool",
            text: `[${toolName}] ${output}`.trim(),
            targetId,
          };
        }

        if (message.role === "bashExecution") {
          const command =
            typeof message.command === "string" && message.command
              ? message.command
              : "(command)";
          const output =
            typeof message.output === "string"
              ? message.output
              : this.extractPreviewText(message.output);
          return {
            role: "tool",
            text: `[$ ${command}] ${output}`.trim(),
            targetId,
          };
        }

        return null;
      })
      .filter((entry): entry is SidebarEntry => !!entry);

    return entries.filter((entry) => {
      if (this.sidebarFilter === "user-only" && entry.role !== "user") {
        return false;
      }
      if (this.sidebarFilter === "no-tools" && entry.role === "tool") {
        return false;
      }

      if (!query) return true;
      return `${entry.role} ${entry.text}`.toLowerCase().includes(query);
    });
  }

  private extractPromptText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content ?? "");

    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        return "";
      })
      .join("\n")
      .trim();
  }

  private extractPreviewText(content: unknown): string {
    if (typeof content === "string") {
      return content.replace(/\s+/g, " ").trim().slice(0, 140);
    }

    if (!Array.isArray(content)) {
      return String(content ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
    }

    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "thinking" && typeof p.thinking === "string") {
          return p.thinking;
        }
        return "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return text.slice(0, 140);
  }

  private messageDomId(renderIndex: number): string {
    return `msg-${renderIndex}`;
  }

  private computeStats(renderable: AgentMessageData[]): SessionStats {
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;

    for (const message of renderable) {
      if (message.role === "user" || message.role === "user-with-attachments") {
        userMessages++;
      } else if (message.role === "assistant") {
        assistantMessages++;
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (
              part &&
              typeof part === "object" &&
              (part as Record<string, unknown>).type === "toolCall"
            ) {
              toolCalls++;
            }
          }
        }
      } else if (message.role === "toolResult" || message.role === "bashExecution") {
        toolResults++;
      }
    }

    return {
      userMessages,
      assistantMessages,
      toolResults,
      toolCalls,
      totalVisible: renderable.length,
    };
  }

  private getKnownToolSpecs(renderable: AgentMessageData[]): ToolSpec[] {
    const builtins: ToolSpec[] = [
      {
        name: "read",
        description: "Read file contents",
        parameters: {
          properties: {
            path: { type: "string", description: "Path to read" },
            offset: { type: "number", description: "Start line" },
            limit: { type: "number", description: "Line count" },
          },
          required: ["path"],
        },
      },
      {
        name: "edit",
        description: "Replace exact text in a file",
        parameters: {
          properties: {
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["path", "oldText", "newText"],
        },
      },
      {
        name: "write",
        description: "Write content to a file",
        parameters: {
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "bash",
        description: "Execute a shell command",
        parameters: {
          properties: {
            command: { type: "string" },
            timeout: { type: "number" },
          },
          required: ["command"],
        },
      },
    ];

    const byName = new Map<string, ToolSpec>();
    for (const tool of [...builtins, ...this.tools]) {
      if (tool?.name) byName.set(tool.name, tool);
    }

    for (const message of renderable) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (
            part &&
            typeof part === "object" &&
            (part as Record<string, unknown>).type === "toolCall"
          ) {
            const name = (part as Record<string, unknown>).name;
            if (typeof name === "string" && !byName.has(name)) {
              byName.set(name, { name, description: "Custom tool" });
            }
          }
        }
      }

      if (message.role === "toolResult") {
        const name = message.toolName;
        if (typeof name === "string" && name && !byName.has(name)) {
          byName.set(name, { name, description: "Custom tool" });
        }
      }
    }

    return Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  private formatDateTime(iso: string): string {
    if (!iso) return "unknown";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
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

  private updateHashTarget(targetId: string) {
    const nextHash = `#/session/${encodeURIComponent(this.sessionId)}?target=${encodeURIComponent(targetId)}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  }

  private focusMessage(targetId: string) {
    this.updateHashTarget(targetId);
    this.scrollToMessage(targetId);
  }

  private buildShareUrl(targetId: string): string {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}#/session/${encodeURIComponent(this.sessionId)}?target=${encodeURIComponent(targetId)}`;
  }

  private async copyToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fallback below
    }

    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }

  private async onCopyLink(e: CustomEvent<{ targetId: string }>) {
    const targetId = e.detail?.targetId;
    if (!targetId) return;

    const url = this.buildShareUrl(targetId);
    await this.copyToClipboard(url);
    this.focusMessage(targetId);
  }

  private renderExtensionUiDialog() {
    const request = this.extensionUiRequest;
    if (!request) return nothing;

    if (request.method === "select") {
      return html`
        <div
          class="cv-extension-modal-backdrop"
          @click=${() => this.cancelExtensionRequest()}
        ></div>
        <div class="cv-extension-modal" role="dialog" aria-modal="true">
          <div class="cv-extension-modal-title">${request.title}</div>
          <div class="cv-extension-modal-body">
            ${request.options.map(
              (option) => html`
                <button
                  class="cv-extension-option"
                  @click=${() => this.respondExtensionWithValue(option)}
                >
                  ${option}
                </button>
              `,
            )}
          </div>
          <div class="cv-extension-modal-actions">
            <button
              class="cv-extension-btn"
              @click=${() => this.cancelExtensionRequest()}
            >
              Cancel
            </button>
          </div>
        </div>
      `;
    }

    if (request.method === "confirm") {
      return html`
        <div
          class="cv-extension-modal-backdrop"
          @click=${() => this.cancelExtensionRequest()}
        ></div>
        <div class="cv-extension-modal" role="dialog" aria-modal="true">
          <div class="cv-extension-modal-title">${request.title}</div>
          <div class="cv-extension-modal-body cv-extension-confirm">
            ${request.message}
          </div>
          <div class="cv-extension-modal-actions">
            <button
              class="cv-extension-btn"
              @click=${() => this.cancelExtensionRequest()}
            >
              Cancel
            </button>
            <button
              class="cv-extension-btn primary"
              @click=${() => this.respondExtensionWithConfirm(false)}
            >
              No
            </button>
            <button
              class="cv-extension-btn primary"
              @click=${() => this.respondExtensionWithConfirm(true)}
            >
              Yes
            </button>
          </div>
        </div>
      `;
    }

    if (request.method === "input" || request.method === "editor") {
      return html`
        <div
          class="cv-extension-modal-backdrop"
          @click=${() => this.cancelExtensionRequest()}
        ></div>
        <div class="cv-extension-modal" role="dialog" aria-modal="true">
          <div class="cv-extension-modal-title">${request.title}</div>
          <div class="cv-extension-modal-body">
            <textarea
              class="cv-extension-textarea"
              placeholder=${request.method === "input"
                ? request.placeholder || ""
                : ""}
              .value=${this.extensionUiInput}
              @input=${(e: InputEvent) =>
                (this.extensionUiInput = (e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </div>
          <div class="cv-extension-modal-actions">
            <button
              class="cv-extension-btn"
              @click=${() => this.cancelExtensionRequest()}
            >
              Cancel
            </button>
            <button
              class="cv-extension-btn primary"
              @click=${() => this.respondExtensionWithValue(this.extensionUiInput)}
            >
              Submit
            </button>
          </div>
        </div>
      `;
    }

    return nothing;
  }

  // ---- Render ----

  render() {
    const renderableMessages = this.getRenderableMessages();
    const sidebarEntries = this.getSidebarEntries(renderableMessages);
    const stats = this.computeStats(renderableMessages);
    const knownTools = this.getKnownToolSpecs(renderableMessages);
    const systemPrompt = this.systemPrompt.trim();
    const promptPreviewLines = 10;
    const promptLines = systemPrompt ? systemPrompt.split("\n") : [];
    const promptPreview = promptLines.slice(0, promptPreviewLines).join("\n");
    const promptRemainder = Math.max(0, promptLines.length - promptPreviewLines);

    return html`
      <div class="cv-header">
        <button
          class="cv-back-btn"
          @click=${() => (window.location.hash = "#/")}
        >
          &#8592;
        </button>

        ${this.renamingName
          ? html`
              <input
                class="cv-title-input"
                .value=${this.editName}
                @input=${(e: InputEvent) =>
                  (this.editName = (e.target as HTMLInputElement).value)}
                @keydown=${this.onTitleKeydown}
                @blur=${this.commitRename}
              />
            `
          : html`
              <div class="cv-title" @click=${this.startRename}>
                ${this.sessionName}
              </div>
            `}

        <button
          class="cv-gear-btn"
          @click=${() => (this.settingsOpen = true)}
        >
          &#9881;
        </button>
      </div>

      ${this.reconnecting
        ? html`<div class="cv-banner reconnecting">
            Connection lost. Reconnecting&hellip;
          </div>`
        : nothing}
      ${this.connected && this.modelsLoaded && !this.currentModel
        ? html`<div class="cv-banner warning">
            No model available. Configure an API key or model provider in pi.
          </div>`
        : this.error
          ? html`<div class="cv-banner error">${this.error}</div>`
          : nothing}

      ${this.extensionNotifications.length > 0
        ? html`
            <div class="cv-extension-notification-stack">
              ${this.extensionNotifications.map(
                (note) => html`
                  <div class="cv-extension-note ${note.notifyType}">
                    ${note.message}
                  </div>
                `,
              )}
            </div>
          `
        : nothing}

      <div class="cv-body">
        <aside class="cv-sidebar" aria-label="Message history">
          <div class="cv-sidebar-controls">
            <input
              class="cv-sidebar-search"
              placeholder="Search..."
              .value=${this.sidebarSearch}
              @input=${(e: InputEvent) =>
                (this.sidebarSearch = (e.target as HTMLInputElement).value)}
            />
            <div class="cv-sidebar-filters">
              ${(
                [
                  ["default", "Default"],
                  ["no-tools", "No-tools"],
                  ["user-only", "User"],
                  ["all", "All"],
                ] as Array<[SidebarFilterMode, string]>
              ).map(
                ([mode, label]) => html`
                  <button
                    class="cv-filter-btn ${this.sidebarFilter === mode
                      ? "active"
                      : ""}"
                    @click=${() => (this.sidebarFilter = mode)}
                  >
                    ${label}
                  </button>
                `,
              )}
            </div>
          </div>

          <div class="cv-tree-container">
            ${sidebarEntries.map(
              (entry) => html`
                <button
                  class="cv-tree-node cv-tree-role-${entry.role}"
                  @click=${() => this.focusMessage(entry.targetId)}
                  title=${entry.text}
                >
                  <span class="cv-tree-marker">•</span>
                  <span class="cv-tree-role-label">${entry.role}:</span>
                  <span class="cv-tree-text">${entry.text}</span>
                </button>
              `,
            )}
          </div>
          <div class="cv-tree-status">${sidebarEntries.length} entries</div>
        </aside>

        <div class="cv-main-col">
          <div class="cv-messages">
            <div class="cv-shortcuts">
              <button
                class="cv-shortcut-btn ${this.showThinking ? "active" : ""}"
                @click=${() => (this.showThinking = !this.showThinking)}
              >
                Ctrl+T thinking
              </button>
              <button
                class="cv-shortcut-btn ${this.expandToolOutputs ? "active" : ""}"
                @click=${() => (this.expandToolOutputs = !this.expandToolOutputs)}
              >
                Ctrl+O tools
              </button>
            </div>

            <div class="cv-info-stack">
              <div class="cv-info-card">
                <div class="cv-info-title">Session metadata</div>
                <div class="cv-info-grid">
                  <div class="cv-info-item"><span>Session</span><strong>${this.sessionId}</strong></div>
                  <div class="cv-info-item"><span>Created</span><strong>${this.formatDateTime(this.sessionCreatedAt)}</strong></div>
                  <div class="cv-info-item"><span>Last Activity</span><strong>${this.formatDateTime(this.sessionLastActivityAt)}</strong></div>
                  <div class="cv-info-item"><span>Model</span><strong>${this.currentProvider ? `${this.currentProvider}/${this.currentModel}` : this.currentModel || "unknown"}</strong></div>
                  <div class="cv-info-item"><span>Thinking</span><strong>${this.currentThinkingLevel}</strong></div>
                  <div class="cv-info-item"><span>Steering Queue</span><strong>${this.currentSteeringMode}</strong></div>
                  <div class="cv-info-item"><span>Follow-up Queue</span><strong>${this.currentFollowUpMode}</strong></div>
                  <div class="cv-info-item"><span>Messages</span><strong>${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolResults} tool</strong></div>
                  <div class="cv-info-item"><span>Tool Calls</span><strong>${stats.toolCalls}</strong></div>
                  <div class="cv-info-item"><span>Slash Commands</span><strong>${this.commandsLoading ? "loading…" : this.commands.length}</strong></div>
                  <div class="cv-info-item"><span>Persisted</span><strong>${this.persistedMessageCount}${this.pendingMessageCount ? ` (+${this.pendingMessageCount} pending)` : ""}</strong></div>
                </div>
              </div>

              ${systemPrompt
                ? html`
                    <details class="cv-info-card cv-system-prompt" ?open=${promptLines.length <= promptPreviewLines}>
                      <summary class="cv-info-title">System prompt</summary>
                      <div class="cv-system-prompt-body">
                        <pre>${promptLines.length > promptPreviewLines ? promptPreview : systemPrompt}</pre>
                        ${promptRemainder > 0
                          ? html`<div class="cv-system-prompt-hint">... (${promptRemainder} more lines)</div>
                              <pre class="cv-system-prompt-full">${systemPrompt}</pre>`
                          : nothing}
                      </div>
                    </details>
                  `
                : html`
                    <div class="cv-info-card cv-system-prompt muted">
                      <div class="cv-info-title">System prompt</div>
                      <div class="cv-system-prompt-empty">No explicit system prompt provided by RPC state.</div>
                    </div>
                  `}

              <details class="cv-info-card cv-tools-card">
                <summary class="cv-info-title">Available tools (${knownTools.length})</summary>
                <div class="cv-tools-list">
                  ${knownTools.map(
                    (tool) => html`
                      <details class="cv-tool-item">
                        <summary>
                          <span class="cv-tool-name">${tool.name}</span>
                          <span class="cv-tool-desc">${tool.description || ""}</span>
                        </summary>
                        ${tool.parameters?.properties
                          ? html`
                              <div class="cv-tool-params">
                                ${Object.entries(tool.parameters.properties).map(
                                  ([name, def]) => html`
                                    <div class="cv-tool-param">
                                      <span class="cv-tool-param-name">${name}</span>
                                      <span class="cv-tool-param-type">${def?.type || "any"}</span>
                                      <span
                                        class="cv-tool-param-req"
                                        >${tool.parameters?.required?.includes(name)
                                          ? "required"
                                          : "optional"}</span
                                      >
                                      ${def?.description
                                        ? html`<div class="cv-tool-param-desc">${def.description}</div>`
                                        : nothing}
                                    </div>
                                  `,
                                )}
                              </div>
                            `
                          : html`<div class="cv-tool-params cv-tool-params-empty">No parameter schema available.</div>`}
                      </details>
                    `,
                  )}
                </div>
              </details>

              ${this.extensionStatuses.length > 0
                ? html`
                    <div class="cv-info-card cv-extension-statuses">
                      <div class="cv-info-title">Extension status</div>
                      <div class="cv-extension-status-list">
                        ${this.extensionStatuses.map(
                          (status) => html`
                            <div class="cv-extension-status-item">
                              <span>${status.key}</span>
                              <strong>${status.text || ""}</strong>
                            </div>
                          `,
                        )}
                      </div>
                    </div>
                  `
                : nothing}

              ${this.extensionWidgets.length > 0
                ? html`
                    <div class="cv-info-card cv-extension-widgets">
                      <div class="cv-info-title">Extension widgets</div>
                      ${this.extensionWidgets.map(
                        (widget) => html`
                          <details class="cv-extension-widget-item">
                            <summary>
                              <span>${widget.key}</span>
                              <span>${widget.placement}</span>
                            </summary>
                            <pre>${widget.lines.join("\n")}</pre>
                          </details>
                        `,
                      )}
                    </div>
                  `
                : nothing}
            </div>

            <message-list
              .messages=${renderableMessages}
              .allMessages=${this.messages}
              .isStreaming=${this.isStreaming}
              .pendingToolCalls=${this.pendingToolCalls}
              .showThinking=${this.showThinking}
              .expandToolOutputs=${this.expandToolOutputs}
              @copy-link=${this.onCopyLink}
            ></message-list>

            ${this.isStreaming
              ? html`<div class="cv-streaming-indicator">
                  <span class="cv-streaming-cursor"></span>
                </div>`
              : nothing}

            ${this.wasInterrupted && !this.isStreaming
              ? html`<div class="cv-interrupted">Interrupted</div>`
              : nothing}
          </div>

          <chat-input
            .isStreaming=${this.isStreaming}
            .disabled=${this.modelsLoaded && !this.currentModel}
            .commands=${this.commands}
            .commandsLoading=${this.commandsLoading}
            @send=${this.onSend}
            @steer=${this.onSteer}
            @follow-up=${this.onFollowUp}
            @stop=${this.onStop}
          ></chat-input>
        </div>
      </div>

      ${this.renderExtensionUiDialog()}

      <settings-panel
        .open=${this.settingsOpen}
        .currentModel=${this.currentModel}
        .currentProvider=${this.currentProvider}
        .currentThinkingLevel=${this.currentThinkingLevel}
        .currentSteeringMode=${this.currentSteeringMode}
        .currentFollowUpMode=${this.currentFollowUpMode}
        .models=${this.models}
        @close=${() => (this.settingsOpen = false)}
        @model-change=${this.onModelChange}
        @thinking-change=${this.onThinkingChange}
        @steering-mode-change=${this.onSteeringModeChange}
        @follow-up-mode-change=${this.onFollowUpModeChange}
      ></settings-panel>
    `;
  }
}
