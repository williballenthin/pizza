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
  SessionActivityUpdate,
} from "@shared/types.js";
import { extractPromptText } from "./message-shaping.js";
import { ExtensionUiState } from "./extension-ui-state.js";

export interface SessionRuntimeState {
  baseMessages: AgentMessageData[];
  streamingTail: AgentMessageData[];
  isStreaming: boolean;
  isAgentWorking: boolean;
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
  hasLoadedState: boolean;
}

export type SessionRuntimeListener = (state: SessionRuntimeState) => void;

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
  private activitySource: EventSource | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listener: SessionRuntimeListener;
  public extensionUiState: ExtensionUiState;

  private state: SessionRuntimeState = {
    baseMessages: [],
    streamingTail: [],
    isStreaming: false,
    isAgentWorking: false,
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
    hasLoadedState: false,
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

    // Also connect to activity SSE for authoritative agent working status
    this.connectActivitySource();
  }

  private connectActivitySource() {
    if (this.activitySource) {
      this.activitySource.close();
    }

    // Fetch initial activity status
    this.fetchActivityStatus();

    this.activitySource = new EventSource("/api/sessions/events");

    this.activitySource.onmessage = (ev) => {
      try {
        const update: SessionActivityUpdate = JSON.parse(ev.data);
        if (update.sessionId === this.sessionId && update.activity) {
          this.updateState({ isAgentWorking: update.activity.isWorking });
        }
      } catch {
        // Ignore parse errors
      }
    };

    this.activitySource.onerror = () => {
      // The browser will automatically try to reconnect EventSource
    };
  }

  private async fetchActivityStatus() {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = await res.json();
      const session = data.sessions?.find((s: any) => s.id === this.sessionId);
      if (session?.activity) {
        this.updateState({ isAgentWorking: session.activity.isWorking });
      }
    } catch {
      // Ignore fetch errors
    }
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
    if (this.activitySource) {
      this.activitySource.close();
      this.activitySource = null;
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
      isStreaming: msg.isStreaming,
      currentThinkingLevel: (msg.thinkingLevel as ThinkingLevel) || "off",
      autoCompactionEnabled: msg.autoCompactionEnabled === true,
      pendingMessageCount: msg.pendingMessageCount || 0,
      tools: msg.tools || [],
      hasLoadedState: true,
    };

    if (incomingMessages.length > 0 || this.state.baseMessages.length === 0) {
      patch.baseMessages = incomingMessages;
      patch.streamingTail = [];
    }

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
    switch (event.type) {
      case "agent_start":
        this.updateState({ isStreaming: true, wasInterrupted: false });
        break;
      case "agent_end":
        this.finalizeStreaming();
        this.updateState({ isStreaming: false });
        break;
      case "message_start":
        this.streamMsg = { role: "assistant", content: [], timestamp: Date.now() };
        break;
      case "message_update":
        this.handleAgentMessageUpdate(event);
        break;
      case "message_end":
        this.finalizeStreaming();
        break;
      case "tool_execution_start":
        if ((event as any).toolCallId) this.pendingToolCalls.add((event as any).toolCallId);
        break;
      case "tool_execution_update":
        this.handleToolExecutionUpdate(event);
        break;
      case "tool_execution_end":
        if ((event as any).toolCallId) {
          this.pendingToolCalls.delete((event as any).toolCallId);
          this.partialToolResults.delete((event as any).toolCallId);
        }
        break;
      case "auto_compaction_start":
        this.appendInlineNotification("Auto-compacting context...", "warning");
        break;
      case "auto_compaction_end":
        if ((event as any).aborted) this.appendInlineNotification("Auto-compaction cancelled.", "warning");
        else if ((event as any).errorMessage) this.appendInlineNotification((event as any).errorMessage, "error");
        break;
      case "response":
        this.handleAgentResponse(event);
        break;
      case "extension_ui_request":
        this.extensionUiState.handleRequest(event as unknown as ExtensionUIRequest);
        break;
      case "turn_end":
        this.send({ type: "get_state" });
        break;
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
      const baseMessages = [...this.state.baseMessages, assistantMsg];
      this.updateState({ baseMessages, streamingTail: [] });
      this.streamMsg = null;
    }
  }

  private scheduleStreamUpdate() {
    if (this.streamUpdatePending) return;
    this.streamUpdatePending = true;
    requestAnimationFrame(() => {
      this.streamUpdatePending = false;
      const tail = this.buildStreamingTail();
      const patch: Partial<SessionRuntimeState> = { streamingTail: tail };
      if (!setsEqual(this.state.pendingToolCalls, this.pendingToolCalls)) {
        patch.pendingToolCalls = new Set(this.pendingToolCalls);
      }
      this.updateState(patch);
    });
  }

  private buildStreamingTail(): AgentMessageData[] {
    const results = Array.from(this.partialToolResults.values());
    const tail: AgentMessageData[] = [...results];
    if (this.streamMsg) {
      tail.push({
        ...this.streamMsg,
        content: [...this.streamMsg.content],
        _streamingId: "__streaming__",
      } as AgentMessageData);
    }
    return tail;
  }

  private handleAgentResponse(event: any) {
    this.streamMsg = null;
    this.partialToolResults.clear();
    this.pendingToolCalls.clear();

    const patch: Partial<SessionRuntimeState> = { isStreaming: false, streamingTail: [] };
    if (event.data?.messages) {
      patch.baseMessages = event.data.messages;
      if (event.data.systemPrompt) patch.systemPrompt = event.data.systemPrompt;
      else patch.systemPrompt = this.deriveSystemPrompt(patch.baseMessages!);
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

    const baseMessages = [...this.state.baseMessages, shellMessage];
    this.updateState({ baseMessages });
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
    const baseMessages = [...this.state.baseMessages, noteMessage];
    this.updateState({ baseMessages });
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
    const baseMessages = [...this.state.baseMessages, userMsg];
    this.updateState({
      baseMessages,
      wasInterrupted: false,
    });
  }
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}
