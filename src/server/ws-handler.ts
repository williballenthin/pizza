import { spawn, type ChildProcess } from "child_process";
import type { WebSocket } from "ws";
import type { RpcProcess } from "./rpc-process.js";
import type { SessionManager } from "./session-manager.js";
import type { GlobalModelScope } from "./global-model-scope.js";
import type {
  ClientMessage,
  RpcEvent,
  ServerMessage,
  ModelInfo,
  SlashCommandSpec,
  ImageContent,
  AgentMessageData,
  SessionMessageStats,
} from "../shared/types.js";

type PendingCommand =
  | { kind: "get_state" }
  | { kind: "get_state_with_messages"; stateData: Record<string, unknown> }
  | { kind: "get_available_models" }
  | { kind: "get_commands" }
  | { kind: "set_model" }
  | { kind: "set_thinking_level" }
  | { kind: "set_steering_mode" }
  | { kind: "set_follow_up_mode" }
  | { kind: "bash"; command: string; includeInContext: boolean };

interface LocalShellRun {
  command: string;
  proc: ChildProcess;
  promise: Promise<LocalShellResult>;
  aborted: boolean;
}

export function mapAvailableModels(
  rawModels: Array<Record<string, unknown>>,
  enabledModels: ReadonlySet<string> | null,
): ModelInfo[] {
  const filteredModels = enabledModels
    ? rawModels.filter((m) => {
        const provider = (m.provider as string) || "";
        const id = (m.modelId as string) || (m.id as string) || "";
        return enabledModels.has(`${provider}/${id}`);
      })
    : rawModels;

  return filteredModels.map((m): ModelInfo => ({
    provider: (m.provider as string) || "",
    id: (m.modelId as string) || (m.id as string) || "",
    label:
      (m.name as string) ||
      (m.label as string) ||
      (m.modelId as string) ||
      (m.id as string) ||
      "",
  }));
}

const LOCAL_SHELL_MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_CLIENT_IMAGES_PER_MESSAGE = 6;
const MAX_CLIENT_IMAGE_BYTES = 10 * 1024 * 1024;

const CLIENT_MESSAGE_TYPES: ReadonlySet<ClientMessage["type"]> = new Set([
  "prompt",
  "steer",
  "follow_up",
  "bash",
  "abort",
  "get_state",
  "set_model",
  "set_thinking_level",
  "set_steering_mode",
  "set_follow_up_mode",
  "get_available_models",
  "get_commands",
  "extension_ui_response",
]);

type ClientMessageHandlers = {
  [K in ClientMessage["type"]]: (
    msg: Extract<ClientMessage, { type: K }>,
  ) => Promise<void> | void;
};

function dispatchClientMessage(
  msg: ClientMessage,
  handlers: ClientMessageHandlers,
): Promise<void> | void {
  const handler = handlers[msg.type] as (
    msg: ClientMessage,
  ) => Promise<void> | void;
  return handler(msg);
}

export async function handleSessionWebSocket(
  ws: WebSocket,
  sessionId: string,
  sessions: SessionManager,
  globalModelScope: GlobalModelScope,
): Promise<void> {
  const pendingCommands = new Map<string, PendingCommand>();
  let runningLocalShell: LocalShellRun | null = null;

  const listener = (event: RpcEvent) => {
    if (event.type === "response") {
      const id = event.id as string;
      const pending = pendingCommands.get(id);
      if (pending) {
        const success = event.success !== false;
        if (!success) {
          pendingCommands.delete(id);
          sendJson(ws, {
            type: "error",
            message:
              (event.error as string) ||
              `RPC command failed: ${pending.kind}`,
          });
          return;
        }

        const data = event.data as Record<string, unknown> | undefined;
        const handled = handlePendingRpcResponse(
          pending,
          data,
          ws,
          rpc,
          pendingCommands,
          sessionId,
          sessions,
          globalModelScope,
          event, // Pass the event to get original ID if needed
        );
        if (handled) {
          pendingCommands.delete(id);
          return;
        }

        pendingCommands.delete(id);
        // get_messages and other responses fall through as agent events.
      }
    }

    sendJson(ws, { type: "agent_event", event });
  };

  let rpc: RpcProcess;
  let sessionCwd: string;
  try {
    const result = await sessions.getOrSpawn(sessionId, listener);
    rpc = result.rpc;
    sessionCwd = result.cwd;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to open session";
    sendJson(ws, { type: "error", message });
    ws.close(1011, "Session unavailable");
    return;
  }

  const queuePendingCommand = (
    command: Record<string, unknown>,
    pending: PendingCommand,
  ): void => {
    const id = rpc.send(command);
    pendingCommands.set(id, pending);
  };

  const forwardInputWithImages = (
    type: "prompt" | "steer" | "follow_up",
    text: string,
    images: unknown,
  ) => {
    try {
      const normalizedImages = normalizeClientImages(images);
      rpc.send({ type, message: text, images: normalizedImages });
    } catch (err) {
      sendJson(ws, {
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Invalid image attachment payload",
      });
    }
  };

  const startLocalShellRun = (command: string): void => {
    try {
      const run = startLocalShell(command, sessionCwd);
      const localRun: LocalShellRun = {
        command,
        proc: run.proc,
        promise: run.promise,
        aborted: false,
      };
      runningLocalShell = localRun;

      run.promise
        .then((result) => {
          sendJson(ws, {
            type: "shell_result",
            command,
            includeInContext: false,
            output: result.output,
            exitCode: result.exitCode,
            cancelled: result.cancelled || localRun.aborted,
            truncated: result.truncated,
            timestamp: Date.now(),
          });
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Local shell failed";
          sendJson(ws, { type: "error", message });
        })
        .finally(() => {
          if (runningLocalShell?.proc === run.proc) {
            runningLocalShell = null;
          }
        });
    } catch (err) {
      sendJson(ws, {
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to start local shell command",
      });
    }
  };

  const stopRunningLocalShell = (): void => {
    if (!runningLocalShell) return;
    runningLocalShell.aborted = true;
    runningLocalShell.proc.kill("SIGTERM");
    runningLocalShell = null;
  };

  const handlers: ClientMessageHandlers = {
    prompt: (msg) => {
      forwardInputWithImages("prompt", msg.text, msg.images);
    },
    steer: (msg) => {
      forwardInputWithImages("steer", msg.text, msg.images);
    },
    follow_up: (msg) => {
      forwardInputWithImages("follow_up", msg.text, msg.images);
    },
    bash: (msg) => {
      const command = msg.command.trim();
      if (!command) {
        sendJson(ws, { type: "error", message: "Shell command is empty" });
        return;
      }

      const includeInContext = msg.includeInContext !== false;
      if (includeInContext) {
        queuePendingCommand(
          { type: "bash", command },
          { kind: "bash", command, includeInContext: true },
        );
        return;
      }

      if (runningLocalShell) {
        sendJson(ws, {
          type: "error",
          message: "A local shell command is already running",
        });
        return;
      }

      startLocalShellRun(command);
    },
    abort: () => {
      rpc.send({ type: "abort" });
      stopRunningLocalShell();
    },
    get_state: () => {
      queuePendingCommand({ type: "get_state" }, { kind: "get_state" });
    },
    set_model: async (msg) => {
      queuePendingCommand(
        { type: "set_model", provider: msg.provider, modelId: msg.model },
        { kind: "set_model" },
      );
      await sessions.addCustomMessage(
        sessionId,
        "model_change",
        `Model changed to **${msg.model}** (${msg.provider})`,
        { provider: msg.provider, modelId: msg.model },
      );
    },
    set_thinking_level: async (msg) => {
      queuePendingCommand(
        { type: "set_thinking_level", level: msg.level },
        { kind: "set_thinking_level" },
      );
      await sessions.addCustomMessage(
        sessionId,
        "thinking_level_change",
        `Thinking level changed to **${msg.level}**`,
        { level: msg.level },
      );
    },
    set_steering_mode: (msg) => {
      queuePendingCommand(
        { type: "set_steering_mode", mode: msg.mode },
        { kind: "set_steering_mode" },
      );
    },
    set_follow_up_mode: (msg) => {
      queuePendingCommand(
        { type: "set_follow_up_mode", mode: msg.mode },
        { kind: "set_follow_up_mode" },
      );
    },
    get_available_models: async () => {
      await globalModelScope.refresh();
      queuePendingCommand(
        { type: "get_available_models" },
        { kind: "get_available_models" },
      );
    },
    get_commands: () => {
      queuePendingCommand({ type: "get_commands" }, { kind: "get_commands" });
    },
    extension_ui_response: (msg) => {
      const base = { type: "extension_ui_response", id: msg.id };
      if ("value" in msg) {
        rpc.send({ ...base, value: msg.value });
      } else if ("confirmed" in msg) {
        rpc.send({ ...base, confirmed: msg.confirmed });
      } else {
        rpc.send({ ...base, cancelled: true });
      }
    },
  };

  queuePendingCommand({ type: "get_state" }, { kind: "get_state" });

  ws.on("message", async (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      sendJson(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (!hasMessageType(parsed)) {
      sendJson(ws, { type: "error", message: "Invalid message payload" });
      return;
    }

    if (!rpc.alive) {
      try {
        const result = await sessions.getOrSpawn(sessionId, listener);
        rpc = result.rpc;
        sessionCwd = result.cwd;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to open session";
        sendJson(ws, { type: "error", message });
        return;
      }
    }

    if (!isClientMessageType(parsed.type)) {
      sendJson(ws, {
        type: "error",
        message: `Unknown message type: ${parsed.type}`,
      });
      return;
    }

    await dispatchClientMessage(parsed as ClientMessage, handlers);
  });

  ws.on("close", () => {
    stopRunningLocalShell();
    sessions.detach(sessionId, listener);
  });

  ws.on("error", () => {
    stopRunningLocalShell();
    sessions.detach(sessionId, listener);
  });

}

interface LocalShellResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
}

function handlePendingRpcResponse(
  pending: PendingCommand,
  data: Record<string, unknown> | undefined,
  ws: WebSocket,
  rpc: RpcProcess,
  pendingCommands: Map<string, PendingCommand>,
  sessionId: string,
  sessions: SessionManager,
  globalModelScope: GlobalModelScope,
  _event: RpcEvent,
): boolean {
  switch (pending.kind) {
    case "get_state": {
      const messageId = rpc.send({ type: "get_messages" });
      pendingCommands.set(messageId, {
        kind: "get_state_with_messages",
        stateData: data || {},
      });
      return true;
    }

    case "get_state_with_messages": {
      const sd = pending.stateData;
      const model = sd.model as
        | {
            provider?: string;
            modelId?: string;
            id?: string;
            contextWindow?: number;
            maxTokens?: number;
          }
        | null
        | undefined;

      const liveMessages = (data?.messages as AgentMessageData[]) || [];
      sessions.getHistory(sessionId).then((history) => {
        const merged = mergeMessages(history, liveMessages);
        sendJson(ws, {
          type: "state",
          model: model
            ? {
                provider: model.provider || "",
                id: model.modelId || model.id || "",
                contextWindow:
                  typeof model.contextWindow === "number"
                    ? model.contextWindow
                    : undefined,
                maxTokens:
                  typeof model.maxTokens === "number"
                    ? model.maxTokens
                    : undefined,
              }
            : null,
          thinkingLevel: (sd.thinkingLevel as string) || "off",
          steeringMode:
            sd.steeringMode === "all" ||
            sd.steeringMode === "one-at-a-time"
              ? sd.steeringMode
              : undefined,
          followUpMode:
            sd.followUpMode === "all" ||
            sd.followUpMode === "one-at-a-time"
              ? sd.followUpMode
              : undefined,
          sessionName:
            typeof sd.sessionName === "string"
              ? sd.sessionName
              : undefined,
          isStreaming: (sd.isStreaming as boolean) || false,
          autoCompactionEnabled: sd.autoCompactionEnabled === true,
          messages: merged,
          messageStats:
            sd.messageStats && typeof sd.messageStats === "object"
              ? (sd.messageStats as SessionMessageStats)
              : undefined,
          pendingMessageCount:
            typeof sd.pendingMessageCount === "number"
              ? (sd.pendingMessageCount as number)
              : undefined,
          systemPrompt:
            typeof sd.systemPrompt === "string"
              ? (sd.systemPrompt as string)
              : undefined,
          tools: Array.isArray(sd.tools)
            ? (sd.tools as Array<Record<string, unknown>>).map((tool) => ({
                name: (tool.name as string) || "tool",
                description: (tool.description as string) || "",
                parameters:
                  tool.parameters && typeof tool.parameters === "object"
                    ? (tool.parameters as {
                        properties?: Record<
                          string,
                          { type?: string; description?: string }
                        >;
                        required?: string[];
                      })
                    : undefined,
              }))
            : undefined,
        });
      });
      return true;
    }

    case "get_available_models": {
      const rawModels = (data?.models as Array<Record<string, unknown>>) || [];
      const enabledModels = globalModelScope.getEnabledModels();
      sendJson(ws, {
        type: "available_models",
        models: mapAvailableModels(rawModels, enabledModels),
      });
      return true;
    }

    case "get_commands": {
      const rawCommands =
        (data?.commands as Array<Record<string, unknown>>) || [];
      sendJson(ws, {
        type: "available_commands",
        commands: rawCommands
          .filter((cmd) => typeof cmd.name === "string")
          .map((cmd): SlashCommandSpec => ({
            name: cmd.name as string,
            description:
              typeof cmd.description === "string" ? cmd.description : undefined,
            source:
              cmd.source === "extension" ||
              cmd.source === "prompt" ||
              cmd.source === "skill"
                ? cmd.source
                : "prompt",
            location:
              cmd.location === "user" ||
              cmd.location === "project" ||
              cmd.location === "path"
                ? cmd.location
                : undefined,
            path: typeof cmd.path === "string" ? cmd.path : undefined,
          })),
      });
      return true;
    }

    case "bash": {
      const output = typeof data?.output === "string" ? data.output : "";
      const exitCode =
        typeof data?.exitCode === "number" ? data.exitCode : undefined;
      const cancelled = data?.cancelled === true;
      const truncated = data?.truncated === true;
      const fullOutputPath =
        typeof data?.fullOutputPath === "string"
          ? data.fullOutputPath
          : undefined;

      sendJson(ws, {
        type: "shell_result",
        command: pending.command,
        includeInContext: pending.includeInContext,
        output,
        exitCode,
        cancelled,
        truncated,
        fullOutputPath,
        timestamp: Date.now(),
      });

      if (pending.includeInContext) {
        const refreshId = rpc.send({ type: "get_state" });
        pendingCommands.set(refreshId, { kind: "get_state" });
      }
      return true;
    }

    case "set_model":
    case "set_thinking_level":
    case "set_steering_mode":
    case "set_follow_up_mode": {
      const refreshId = rpc.send({ type: "get_state" });
      pendingCommands.set(refreshId, { kind: "get_state" });
      return true;
    }

    default:
      return false;
  }
}

export function mergeMessages(
  history: AgentMessageData[],
  live: AgentMessageData[],
): AgentMessageData[] {
  if (live.length === 0) return history;

  // Find the intersection point
  let splitIndex = -1;
  const firstLive = live[0];

  // If live[0] has an ID, try to find it in history
  if (firstLive.id) {
    splitIndex = history.findIndex((m) => m.id === firstLive.id);
  }

  // Fallback: match by role and timestamp if ID is missing or not found
  if (splitIndex === -1 && firstLive.timestamp) {
    splitIndex = history.findIndex(
      (m) => m.role === firstLive.role && m.timestamp === firstLive.timestamp,
    );
  }

  if (splitIndex === -1) {
    // No intersection found. 
    // Avoid double-appending if live[0] looks like it COULD be in history but we missed it
    return [...history, ...live];
  }

  // Restore IDs from history to live messages to maintain consistency
  for (let i = 0; i < live.length; i++) {
    const historyIdx = splitIndex + i;
    if (historyIdx < history.length && !live[i].id) {
      const h = history[historyIdx];
      const l = live[i];
      if (h.role === l.role && h.timestamp === l.timestamp) {
        live[i].id = h.id;
      }
    }
  }

  // Join everything before the intersection with all live messages (which now have IDs)
  return [...history.slice(0, splitIndex), ...live];
}

function hasMessageType(value: unknown): value is { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isClientMessageType(type: string): type is ClientMessage["type"] {
  return CLIENT_MESSAGE_TYPES.has(type as ClientMessage["type"]);
}

function normalizeClientImages(images: unknown): ImageContent[] | undefined {
  if (images == null) return undefined;
  if (!Array.isArray(images)) {
    throw new Error("Invalid image payload.");
  }
  if (images.length === 0) return undefined;
  if (images.length > MAX_CLIENT_IMAGES_PER_MESSAGE) {
    throw new Error(
      `Too many images. Maximum ${MAX_CLIENT_IMAGES_PER_MESSAGE} images per message.`,
    );
  }

  const normalized: ImageContent[] = [];

  for (const image of images) {
    if (!image || typeof image !== "object") {
      throw new Error("Invalid image payload.");
    }

    const raw = image as Record<string, unknown>;
    if (raw.type !== "image") {
      throw new Error("Invalid image payload.");
    }

    const mimeType =
      typeof raw.mimeType === "string" ? raw.mimeType.trim() : "";
    if (!mimeType.startsWith("image/")) {
      throw new Error("Unsupported image type.");
    }

    const data = typeof raw.data === "string" ? raw.data.trim() : "";
    if (!data || !isLikelyBase64(data)) {
      throw new Error("Invalid image data.");
    }

    if (estimateBase64Bytes(data) > MAX_CLIENT_IMAGE_BYTES) {
      throw new Error(
        `Image too large. Maximum size is ${Math.round(MAX_CLIENT_IMAGE_BYTES / 1024 / 1024)}MB.`,
      );
    }

    normalized.push({ type: "image", data, mimeType });
  }

  return normalized.length > 0 ? normalized : undefined;
}

function isLikelyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function estimateBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function startLocalShell(command: string, cwd: string): {
  proc: ChildProcess;
  promise: Promise<LocalShellResult>;
} {
  const proc = spawn(command, {
    cwd,
    shell: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let truncated = false;

  const append = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    if (!text) return;

    if (truncated) return;

    const remaining = LOCAL_SHELL_MAX_OUTPUT_BYTES - Buffer.byteLength(output);
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    const chunkBytes = Buffer.byteLength(text);
    if (chunkBytes <= remaining) {
      output += text;
      return;
    }

    output += Buffer.from(text).subarray(0, remaining).toString();
    truncated = true;
  };

  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);

  const promise = new Promise<LocalShellResult>((resolve, reject) => {
    proc.on("error", (err) => reject(err));

    proc.on("close", (code, signal) => {
      resolve({
        output,
        exitCode: typeof code === "number" ? code : undefined,
        cancelled: !!signal,
        truncated,
      });
    });
  });

  return { proc, promise };
}

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
