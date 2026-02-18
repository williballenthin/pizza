import { spawn, type ChildProcess } from "child_process";
import type { WebSocket } from "ws";
import type { RpcProcess } from "./rpc-process.js";
import { SessionBusyError, type SessionManager } from "./session-manager.js";
import type {
  ClientMessage,
  RpcEvent,
  ServerMessage,
  ModelInfo,
  SlashCommandSpec,
} from "@shared/types.js";

type PendingCommand =
  | { kind: "get_state" }
  | { kind: "get_messages" }
  | { kind: "get_available_models" }
  | { kind: "get_commands" }
  | { kind: "bash"; command: string; includeInContext: boolean };

interface LocalShellRun {
  command: string;
  proc: ChildProcess;
  promise: Promise<LocalShellResult>;
}

const LOCAL_SHELL_MAX_OUTPUT_BYTES = 50 * 1024;

export async function handleSessionWebSocket(
  ws: WebSocket,
  sessionId: string,
  sessions: SessionManager,
): Promise<void> {
  const pendingCommands = new Map<string, PendingCommand>();
  let runningLocalShell: LocalShellRun | null = null;

  const listener = (event: RpcEvent) => {
    if (event.type === "response") {
      const id = event.id as string;
      const pending = pendingCommands.get(id);
      if (pending) {
        pendingCommands.delete(id);

        const success = event.success !== false;
        const data = event.data as Record<string, unknown> | undefined;

        if (!success) {
          sendJson(ws, {
            type: "error",
            message:
              (event.error as string) ||
              `RPC command failed: ${pending.kind}`,
          });
          return;
        }

        if (pending.kind === "get_state") {
          const model = data?.model as
            | { provider?: string; modelId?: string; id?: string }
            | null
            | undefined;

          sendJson(ws, {
            type: "state",
            model: model
              ? {
                  provider: model.provider || "",
                  id: model.modelId || model.id || "",
                }
              : null,
            thinkingLevel: (data?.thinkingLevel as string) || "off",
            steeringMode:
              data?.steeringMode === "all" ||
              data?.steeringMode === "one-at-a-time"
                ? data.steeringMode
                : undefined,
            followUpMode:
              data?.followUpMode === "all" ||
              data?.followUpMode === "one-at-a-time"
                ? data.followUpMode
                : undefined,
            sessionName:
              typeof data?.sessionName === "string"
                ? data.sessionName
                : undefined,
            isStreaming: (data?.isStreaming as boolean) || false,
            messages: [],
            messageCount:
              typeof data?.messageCount === "number"
                ? (data.messageCount as number)
                : undefined,
            pendingMessageCount:
              typeof data?.pendingMessageCount === "number"
                ? (data.pendingMessageCount as number)
                : undefined,
            systemPrompt:
              typeof data?.systemPrompt === "string"
                ? (data.systemPrompt as string)
                : undefined,
            tools: Array.isArray(data?.tools)
              ? (data.tools as Array<Record<string, unknown>>).map((tool) => ({
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

          const msgId = rpc.send({ type: "get_messages" });
          pendingCommands.set(msgId, { kind: "get_messages" });
          return;
        }

        if (pending.kind === "get_available_models") {
          const rawModels =
            (data?.models as Array<Record<string, unknown>>) || [];
          sendJson(ws, {
            type: "available_models",
            models: rawModels.map((m): ModelInfo => ({
              provider: (m.provider as string) || "",
              id: (m.modelId as string) || (m.id as string) || "",
              label:
                (m.name as string) ||
                (m.label as string) ||
                (m.modelId as string) ||
                (m.id as string) ||
                "",
            })),
          });
          return;
        }

        if (pending.kind === "get_commands") {
          const rawCommands =
            (data?.commands as Array<Record<string, unknown>>) || [];
          sendJson(ws, {
            type: "available_commands",
            commands: rawCommands
              .filter((cmd) => typeof cmd.name === "string")
              .map((cmd): SlashCommandSpec => ({
                name: cmd.name as string,
                description:
                  typeof cmd.description === "string"
                    ? cmd.description
                    : undefined,
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
          return;
        }

        if (pending.kind === "bash") {
          const output =
            typeof data?.output === "string" ? data.output : "";
          const exitCode =
            typeof data?.exitCode === "number"
              ? data.exitCode
              : undefined;
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
          return;
        }

        // get_messages and other responses fall through as agent events.
      }
    }

    sendJson(ws, { type: "agent_event", event });
  };

  let rpc: RpcProcess;
  try {
    rpc = await sessions.getOrSpawn(sessionId, listener);
  } catch (err) {
    const message =
      err instanceof SessionBusyError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Failed to open session";
    sendJson(ws, { type: "error", message });
    ws.close(err instanceof SessionBusyError ? 1008 : 1011, "Session unavailable");
    return;
  }

  const stateId = rpc.send({ type: "get_state" });
  pendingCommands.set(stateId, { kind: "get_state" });

  ws.on("message", async (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendJson(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (!rpc.alive) {
      try {
        rpc = await sessions.getOrSpawn(sessionId, listener);
      } catch (err) {
        const message =
          err instanceof SessionBusyError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to open session";
        sendJson(ws, { type: "error", message });
        if (err instanceof SessionBusyError) {
          ws.close(1008, "Session unavailable");
        }
        return;
      }
    }

    switch (msg.type) {
      case "prompt":
        rpc.send({ type: "prompt", message: msg.text });
        break;

      case "steer":
        rpc.send({ type: "steer", message: msg.text });
        break;

      case "follow_up":
        rpc.send({ type: "follow_up", message: msg.text });
        break;

      case "bash": {
        const command = msg.command.trim();
        if (!command) {
          sendJson(ws, { type: "error", message: "Shell command is empty" });
          break;
        }

        const includeInContext = msg.includeInContext !== false;

        if (includeInContext) {
          const id = rpc.send({ type: "bash", command });
          pendingCommands.set(id, {
            kind: "bash",
            command,
            includeInContext: true,
          });
          break;
        }

        if (runningLocalShell) {
          sendJson(ws, {
            type: "error",
            message: "A local shell command is already running",
          });
          break;
        }

        try {
          const run = startLocalShell(command, sessions.cwd);
          runningLocalShell = {
            command,
            proc: run.proc,
            promise: run.promise,
          };

          run.promise
            .then((result) => {
              sendJson(ws, {
                type: "shell_result",
                command,
                includeInContext: false,
                output: result.output,
                exitCode: result.exitCode,
                cancelled: result.cancelled,
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
        break;
      }

      case "abort":
        rpc.send({ type: "abort" });
        break;

      case "abort_bash": {
        rpc.send({ type: "abort_bash" });
        if (runningLocalShell) {
          runningLocalShell.proc.kill("SIGTERM");
        }
        break;
      }

      case "get_state": {
        const id = rpc.send({ type: "get_state" });
        pendingCommands.set(id, { kind: "get_state" });
        break;
      }

      case "set_model":
        rpc.send({
          type: "set_model",
          provider: msg.provider,
          modelId: msg.model,
        });
        break;

      case "set_thinking_level":
        rpc.send({ type: "set_thinking_level", level: msg.level });
        break;

      case "set_steering_mode":
        rpc.send({ type: "set_steering_mode", mode: msg.mode });
        break;

      case "set_follow_up_mode":
        rpc.send({ type: "set_follow_up_mode", mode: msg.mode });
        break;

      case "get_available_models": {
        const id = rpc.send({ type: "get_available_models" });
        pendingCommands.set(id, { kind: "get_available_models" });
        break;
      }

      case "get_commands": {
        const id = rpc.send({ type: "get_commands" });
        pendingCommands.set(id, { kind: "get_commands" });
        break;
      }

      case "extension_ui_response": {
        const base = { type: "extension_ui_response", id: msg.id };
        if ("value" in msg) {
          rpc.send({ ...base, value: msg.value });
        } else if ("confirmed" in msg) {
          rpc.send({ ...base, confirmed: msg.confirmed });
        } else {
          rpc.send({ ...base, cancelled: true });
        }
        break;
      }

      default:
        sendJson(ws, {
          type: "error",
          message: `Unknown message type: ${(msg as { type: string }).type}`,
        });
    }
  });

  ws.on("close", () => {
    if (runningLocalShell) {
      runningLocalShell.proc.kill("SIGTERM");
      runningLocalShell = null;
    }
    sessions.detach(sessionId, listener);
  });

  ws.on("error", () => {
    if (runningLocalShell) {
      runningLocalShell.proc.kill("SIGTERM");
      runningLocalShell = null;
    }
    sessions.detach(sessionId, listener);
  });
}

interface LocalShellResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
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
