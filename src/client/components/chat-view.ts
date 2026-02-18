import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  ClientMessage,
  ServerMessage,
  ModelInfo,
  ThinkingLevel,
  AgentMessageData,
} from "@shared/types.js";

/* ------------------------------------------------------------------ */
/*  Lightweight interfaces for the streaming assistant message we      */
/*  build locally. These match pi-ai's content-block shapes so that   */
/*  pi-web-ui's <assistant-message> can render them.                  */
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

@customElement("chat-view")
export class ChatView extends LitElement {
  // ---- Light DOM — allows pi-web-ui's Tailwind styles to reach
  //      its <message-list>, <assistant-message>, etc. ----
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) sessionId = "";

  @state() private messages: AgentMessageData[] = [];
  @state() private isStreaming = false;
  @state() private currentModel = "";
  @state() private currentProvider = "";
  @state() private currentThinkingLevel: ThinkingLevel = "off";
  @state() private models: ModelInfo[] = [];
  @state() private settingsOpen = false;
  @state() private sessionName = "Session";
  @state() private connected = false;
  @state() private reconnecting = false;
  @state() private error = "";
  @state() private modelsLoaded = false;
  @state() private renamingName = false;
  @state() private editName = "";
  @state() private wasInterrupted = false;

  // Pending tool calls for pi-web-ui MessageList
  private pendingToolCalls = new Set<string>();

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
    this.connect();
    this.loadSessionName();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("sessionId") && changed.get("sessionId") !== undefined) {
      this.cleanup();
      this.messages = [];
      this.streamMsg = null;
      this.wasInterrupted = false;
      this.connect();
      this.loadSessionName();
    }

    // Grab scroll container ref after render
    if (!this.scrollContainer) {
      this.scrollContainer = this.querySelector(".cv-messages");
      this.scrollContainer?.addEventListener("scroll", this.onScroll);
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
        this.scheduleScroll();
        break;

      case "agent_event":
        this.handleAgentEvent(msg.event);
        break;

      case "available_models":
        this.models = msg.models;
        this.modelsLoaded = true;
        break;

      case "error":
        this.error = msg.message;
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
        const output = event.output as string | undefined;

        if (content || output) {
          const resultContent = content || [{ type: "text", text: output || "" }];
          this.partialToolResults.set(id, {
            role: "toolResult",
            toolCallId: id,
            toolName: (event.toolName as string) || "",
            content: resultContent,
            isError: false,
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

      // Append partial tool results (MessageList indexes toolResult
      // messages by toolCallId and passes them to tool-message)
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

  private _lastStreamClone: AgentMessageData | null = null;

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

  // ---- User actions ----

  private onSend(e: CustomEvent<string>) {
    const text = e.detail;
    this.messages = [
      ...this.messages,
      { role: "user", content: text, timestamp: Date.now() } as AgentMessageData,
    ];
    this._lastStreamClone = null;
    this.shouldAutoScroll = true;
    this.wsSend({ type: "prompt", text });
    this.scheduleScroll();
  }

  private onSteer(e: CustomEvent<string>) {
    const text = e.detail;
    // Mark current response as interrupted
    this.wasInterrupted = true;
    this.finalizeStreaming();
    this.messages = [
      ...this.messages,
      { role: "user", content: text, timestamp: Date.now() } as AgentMessageData,
    ];
    this._lastStreamClone = null;
    this.shouldAutoScroll = true;
    this.wsSend({ type: "steer", text });
    this.scheduleScroll();
  }

  private onStop() {
    this.wasInterrupted = true;
    this.wsSend({ type: "abort" });
  }

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

  // ---- Session name ----

  private async loadSessionName() {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = await res.json();
      const session = data.sessions.find(
        (s: { id: string }) => s.id === this.sessionId,
      );
      if (session) this.sessionName = session.name;
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

  // ---- Render ----

  render() {
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

      <div class="cv-messages">
        <message-list
          .messages=${this.messages}
          .isStreaming=${this.isStreaming}
          .pendingToolCalls=${this.pendingToolCalls}
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
        @send=${this.onSend}
        @steer=${this.onSteer}
        @stop=${this.onStop}
      ></chat-input>

      <settings-panel
        .open=${this.settingsOpen}
        .currentModel=${this.currentModel}
        .currentProvider=${this.currentProvider}
        .currentThinkingLevel=${this.currentThinkingLevel}
        .models=${this.models}
        @close=${() => (this.settingsOpen = false)}
        @model-change=${this.onModelChange}
        @thinking-change=${this.onThinkingChange}
      ></settings-panel>
    `;
  }
}
