import type {
  ClientMessage,
  ServerMessage,
  ModelInfo,
  ThinkingLevel,
  AgentMessageData,
  ToolSpec,
  SlashCommandSpec,
  QueueDeliveryMode,
  ImageContent,
  ShellResultMessage,
  StateMessage,
  RpcEvent,
  ExtensionUIRequest,
} from "@shared/types.js";
import { extractPromptText } from "./message-shaping.js";
import { ExtensionUiState } from "./extension-ui-state.js";

export interface SessionRuntimeState {
  messages: AgentMessageData[];
  isStreaming: boolean;
  currentModel: string;
  currentProvider: string;
  currentThinkingLevel: ThinkingLevel;
  currentContextWindow: number | null;
  currentMaxTokens: number | null;
  autoCompactionEnabled: boolean;
  currentSteeringMode: QueueDeliveryMode;
  currentFollowUpMode: QueueDeliveryMode;
  models: ModelInfo[];
  commands: SlashCommandSpec[];
  commandsLoading: boolean;
  sessionName: string;
  connected: boolean;
  reconnecting: boolean;
  error: string;
  wasInterrupted: boolean;
  systemPrompt: string;
  tools: ToolSpec[];
  pendingMessageCount: number;
  pendingToolCalls: Set<string>;
  modelsLoaded: boolean;
}

export type SessionRuntimeListener = (state: SessionRuntimeState) => void;

// Local content blocks for streaming
interface TextBlock { type: "text"; text: string; }
interface ThinkingBlock { type: "thinking"; thinking: string; }
interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; }
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

interface PartialAssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  timestamp: number;
}

export class SessionRuntime {
  private sessionId: string;
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listener: SessionRuntimeListener;
  public extensionUiState: ExtensionUiState;

  private state: SessionRuntimeState = {
    messages: [],
    isStreaming: false,
    currentModel: "",
    currentProvider: "",
    currentThinkingLevel: "off",
    currentContextWindow: null,
    currentMaxTokens: null,
    autoCompactionEnabled: false,
    currentSteeringMode: "one-at-a-time",
    currentFollowUpMode: "one-at-a-time",
    models: [],
    commands: [],
    commandsLoading: false,
    sessionName: "Session",
    connected: false,
    reconnecting: false,
    error: "",
    wasInterrupted: false,
    systemPrompt: "",
    tools: [],
    pendingMessageCount: 0,
    pendingToolCalls: new Set(),
    modelsLoaded: false,
  };

  private pendingToolCalls = new Set<string>();
  private partialToolResults = new Map<string, AgentMessageData>();
  private streamMsg: PartialAssistantMessage | null = null;
  private streamUpdatePending = false;

  constructor(sessionId: string, extensionUiState: ExtensionUiState, listener: SessionRuntimeListener) {
    this.sessionId = sessionId;
    this.extensionUiState = extensionUiState;
    this.listener = listener;
  }

  public connect() {
    this.cleanup();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/sessions/${this.sessionId}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.updateState({ connected: true, reconnecting: false, error: "" });
      this.reconnectAttempt = 0;
      this.send({ type: "get_available_models" });
      this.requestCommands(true);
      this.send({ type: "get_state" });
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        this.handleServerMessage(msg);
      } catch (err) {
        console.error("Failed to parse WS message", err, ev.data);
      }
    };

    this.ws.onclose = () => {
      this.updateState({ connected: false });
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.updateState({ error: "WebSocket error occurred." });
    };
  }

  public cleanup() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.updateState({ reconnecting: true });
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  public send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public optimisticUpdate(patch: Partial<SessionRuntimeState>) {
    this.updateState(patch);
  }

  public requestCommands(force = false) {
    if (!force && (this.state.commandsLoading || this.state.commands.length > 0)) return;
    this.updateState({ commandsLoading: true });
    this.send({ type: "get_commands" });
  }

  private updateState(patch: Partial<SessionRuntimeState>) {
    this.state = { ...this.state, ...patch };
    this.listener(this.state);
  }

  private handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "state":
        this.handleStateMessage(msg);
        break;
      case "agent_event":
        this.handleAgentEvent(msg.event as RpcEvent);
        break;
      case "available_models":
        this.updateState({ models: msg.models, modelsLoaded: true });
        break;
      case "available_commands":
        this.updateState({ commands: msg.commands, commandsLoading: false });
        break;
      case "shell_result":
        this.handleShellResult(msg);
        break;
      case "error":
        this.updateState({ error: msg.message, commandsLoading: false });
        break;
    }
  }

  private handleStateMessage(msg: StateMessage) {
    this.partialToolResults.clear();
    const incomingMessages = msg.messages || [];

    const patch: Partial<SessionRuntimeState> = {
      messages: incomingMessages,
      isStreaming: msg.isStreaming,
      currentThinkingLevel: (msg.thinkingLevel as ThinkingLevel) || "off",
      autoCompactionEnabled: msg.autoCompactionEnabled === true,
      pendingMessageCount: msg.pendingMessageCount || 0,
      tools: msg.tools || [],
    };

    if (msg.model) {
      patch.currentProvider = msg.model.provider;
      patch.currentModel = msg.model.id;
      patch.currentContextWindow = msg.model.contextWindow ?? null;
      patch.currentMaxTokens = msg.model.maxTokens ?? null;
    }

    if (msg.steeringMode) patch.currentSteeringMode = msg.steeringMode;
    if (msg.followUpMode) patch.currentFollowUpMode = msg.followUpMode;
    if (msg.sessionName) patch.sessionName = msg.sessionName;

    if (msg.systemPrompt) {
      patch.systemPrompt = msg.systemPrompt;
    } else {
      patch.systemPrompt = this.deriveSystemPrompt(incomingMessages);
    }

    this.updateState(patch);
  }

  private deriveSystemPrompt(messages: AgentMessageData[]): string {
    for (const message of messages) {
      if (message.role !== "system") continue;
      const text = extractPromptText(message.content);
      if (text) return text;
    }
    return "";
  }

  private handleAgentEvent(event: RpcEvent) {
    const handlers: Record<string, (e: any) => void> = {
      agent_start: () => {
        this.updateState({ isStreaming: true, wasInterrupted: false });
      },
      agent_end: () => {
        this.finalizeStreaming();
        this.updateState({ isStreaming: false });
      },
      message_start: () => {
        this.streamMsg = { role: "assistant", content: [], timestamp: Date.now() };
      },
      message_update: (e) => this.handleAgentMessageUpdate(e),
      message_end: () => {
        this.finalizeStreaming();
      },
      tool_execution_start: (e) => {
        if (e.toolCallId) this.pendingToolCalls.add(e.toolCallId);
      },
      tool_execution_update: (e) => this.handleToolExecutionUpdate(e),
      tool_execution_end: (e) => {
        if (e.toolCallId) {
          this.pendingToolCalls.delete(e.toolCallId);
          this.partialToolResults.delete(e.toolCallId);
        }
      },
      auto_compaction_start: () => {
        this.appendInlineNotification("Auto-compacting context...", "warning");
      },
      auto_compaction_end: (e) => {
        if (e.aborted) this.appendInlineNotification("Auto-compaction cancelled.", "warning");
        else if (e.errorMessage) this.appendInlineNotification(e.errorMessage, "error");
      },
      response: (e) => this.handleAgentResponse(e),
      extension_ui_request: (e) => {
        this.extensionUiState.handleRequest(e as ExtensionUIRequest);
        // Side effects like setTitle/notify should be handled by the listener observing extensionUiState
        // But here we rely on the chat-view's syncExtensionUiState which it calls in its listener.
      },
      turn_end: () => {
        this.send({ type: "get_state" });
      },
    };

    const handler = handlers[event.type];
    if (handler) {
      handler(event);
    }
  }

  private handleAgentMessageUpdate(event: any) {
    if (!this.streamMsg) return;

    const sub = event.assistantMessageEvent;
    if (!sub) return;

    if (sub.type === "text_delta" && sub.delta) {
      const last = this.streamMsg.content[this.streamMsg.content.length - 1];
      if (last?.type === "text") {
        last.text += sub.delta;
      } else {
        this.streamMsg.content.push({ type: "text", text: sub.delta });
      }
      this.scheduleStreamUpdate();
      return;
    }

    if (sub.type === "thinking_delta" && sub.delta) {
      const last = this.streamMsg.content[this.streamMsg.content.length - 1];
      if (last?.type === "thinking") {
        last.thinking += sub.delta;
      } else {
        this.streamMsg.content.push({ type: "thinking", thinking: sub.delta });
      }
      this.scheduleStreamUpdate();
      return;
    }

    if (sub.type === "toolcall_end" && sub.toolCall) {
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
  }

  private handleToolExecutionUpdate(event: any) {
    const id = event.toolCallId;
    if (!id) return;

    const output = event.output;
    const outputText = typeof output === "string" ? output : JSON.stringify(output, null, 2);

    this.partialToolResults.set(id, {
      role: "toolResult",
      toolCallId: id,
      toolName: event.toolName || "",
      content: [{ type: "text", text: outputText }],
      output,
      details: event.details,
      isError: !!event.isError,
      timestamp: Date.now(),
      _partialToolResult: true,
    } as AgentMessageData);
    this.scheduleStreamUpdate();
  }

  private finalizeStreaming() {
    if (this.streamMsg && this.streamMsg.content.length > 0) {
      this.partialToolResults.clear();
      const assistantMsg = { ...this.streamMsg } as AgentMessageData;
      this.updateState({
        messages: [...this.state.messages.filter(m => !(m as any)._partialToolResult), assistantMsg]
      });
      this.streamMsg = null;
    }
  }

  private scheduleStreamUpdate() {
    if (this.streamUpdatePending) return;
    this.streamUpdatePending = true;
    requestAnimationFrame(() => {
      this.streamUpdatePending = false;
      this.updateState({
        messages: this.getMergedMessages(),
        pendingToolCalls: new Set(this.pendingToolCalls),
      });
    });
  }

  private getMergedMessages(): AgentMessageData[] {
    const base = this.state.messages.filter(m => !(m as any)._partialToolResult);
    const results = Array.from(this.partialToolResults.values());
    const merged = [...base, ...results];
    if (this.streamMsg) {
      merged.push(JSON.parse(JSON.stringify(this.streamMsg)));
    }
    return merged;
  }

  private handleAgentResponse(event: any) {
    this.streamMsg = null;
    this.partialToolResults.clear();
    this.pendingToolCalls.clear();

    const patch: Partial<SessionRuntimeState> = { isStreaming: false };
    if (event.data?.messages) {
      patch.messages = event.data.messages;
      if (event.data.systemPrompt) patch.systemPrompt = event.data.systemPrompt;
      else patch.systemPrompt = this.deriveSystemPrompt(patch.messages!);
    }
    if (event.data?.wasInterrupted) {
      patch.wasInterrupted = true;
    }

    this.updateState(patch);
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

    this.updateState({
      messages: [...this.state.messages, shellMessage],
    });
  }

  private appendInlineNotification(text: string, notifyType: "info" | "warning" | "error") {
    const noteMessage: AgentMessageData = {
      role: "custom",
      customType: "notification",
      content: [{ type: "text", text }],
      display: true,
      details: { notifyType },
      timestamp: Date.now(),
    };
    this.updateState({
      messages: [...this.state.messages, noteMessage]
    });
  }

  public appendUserMessage(text: string, images: ImageContent[] = []) {
    let content: any = text;
    if (images.length > 0) {
      content = [];
      if (text) content.push({ type: "text", text });
      content.push(...images);
    }

    const userMsg: AgentMessageData = {
      role: "user",
      content,
      timestamp: Date.now(),
    };
    this.updateState({
      messages: [...this.state.messages, userMsg],
      wasInterrupted: false,
    });
  }
}
