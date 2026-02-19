// ---- Session metadata ----

export type SessionActivityState =
  | "attached"
  | "idle"
  | "active_here"
  | "warm"
  | "inactive";

export interface SessionActivity {
  state: SessionActivityState;
  activeHere: boolean;
  attached: boolean;
  idle: boolean;
  warm: boolean;
  hasRecentClientActivity: boolean;
  recentlyUpdated: boolean;
}

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string; // ISO 8601
  lastActivityAt: string; // ISO 8601
  messageCount: number;
  activity: SessionActivity;
}

// ---- REST responses ----

export interface SessionListResponse {
  sessions: SessionMeta[];
}

export interface SessionCreatedResponse {
  id: string;
}

export interface SessionUpdatedResponse {
  id: string;
  name: string;
}

export interface HealthResponse {
  status: "ok";
  activeSessions: number;
}

// ---- WebSocket: client → server ----

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type ClientMessage =
  | { type: "prompt"; text: string; images?: ImageContent[] }
  | { type: "steer"; text: string; images?: ImageContent[] }
  | { type: "follow_up"; text: string; images?: ImageContent[] }
  | { type: "bash"; command: string; includeInContext?: boolean }
  | { type: "abort" }
  | { type: "abort_bash" }
  | { type: "get_state" }
  | { type: "set_model"; provider: string; model: string }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "set_steering_mode"; mode: QueueDeliveryMode }
  | { type: "set_follow_up_mode"; mode: QueueDeliveryMode }
  | { type: "get_available_models" }
  | { type: "get_commands" }
  | ExtensionUIResponseMessage;

export type ExtensionUIResponseMessage =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

// ---- WebSocket: server → client ----

export type ServerMessage =
  | StateMessage
  | AgentEventMessage
  | AvailableModelsMessage
  | AvailableCommandsMessage
  | ShellResultMessage
  | ErrorMessage;

export interface StateMessage {
  type: "state";
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  steeringMode?: QueueDeliveryMode;
  followUpMode?: QueueDeliveryMode;
  sessionName?: string;
  isStreaming: boolean;
  messages: AgentMessageData[];
  messageCount?: number;
  pendingMessageCount?: number;
  systemPrompt?: string;
  tools?: ToolSpec[];
}

export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

export interface SlashCommandSpec {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: "user" | "project" | "path";
  path?: string;
}

export interface AgentEventMessage {
  type: "agent_event";
  event: RpcEvent;
}

export interface AvailableModelsMessage {
  type: "available_models";
  models: ModelInfo[];
}

export interface AvailableCommandsMessage {
  type: "available_commands";
  commands: SlashCommandSpec[];
}

export interface ShellResultMessage {
  type: "shell_result";
  command: string;
  includeInContext: boolean;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

// ---- Supporting types ----

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type QueueDeliveryMode = "all" | "one-at-a-time";

export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
}

// Generic agent message (mirrors pi's message structure loosely)
export interface AgentMessageData {
  role: string;
  [key: string]: unknown;
}

// RPC event — we pass through the raw structure from pi
export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export type ExtensionUIRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    };
