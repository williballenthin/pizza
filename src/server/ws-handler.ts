import type { WebSocket } from "ws";
import type { SessionManager } from "./session-manager.js";
import type {
  ClientMessage,
  RpcEvent,
  ServerMessage,
  ModelInfo,
} from "@shared/types.js";

export async function handleSessionWebSocket(
  ws: WebSocket,
  sessionId: string,
  sessions: SessionManager,
): Promise<void> {
  const pendingCommands = new Map<string, string>();

  const listener = (event: RpcEvent) => {
    if (event.type === "response") {
      const id = event.id as string;
      const cmdType = pendingCommands.get(id);
      if (cmdType) {
        pendingCommands.delete(id);
        const data = event.data as Record<string, unknown> | undefined;

        if (cmdType === "get_state") {
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
            isStreaming: (data?.isStreaming as boolean) || false,
            messages: [],
          });
          const msgId = rpc.send({ type: "get_messages" });
          pendingCommands.set(msgId, "get_messages");
          return;
        }

        if (cmdType === "get_available_models") {
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

        // get_messages and others — pass through as agent_event
      }
    }
    sendJson(ws, { type: "agent_event", event });
  };

  let rpc = await sessions.getOrSpawn(sessionId, listener);

  const stateId = rpc.send({ type: "get_state" });
  pendingCommands.set(stateId, "get_state");

  ws.on("message", async (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendJson(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (!rpc.alive) {
      rpc = await sessions.getOrSpawn(sessionId, listener);
    }

    switch (msg.type) {
      case "prompt":
        rpc.send({ type: "prompt", message: msg.text });
        break;

      case "steer":
        rpc.send({ type: "steer", message: msg.text });
        break;

      case "abort":
        rpc.send({ type: "abort" });
        break;

      case "get_state": {
        const id = rpc.send({ type: "get_state" });
        pendingCommands.set(id, "get_state");
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

      case "get_available_models": {
        const id = rpc.send({ type: "get_available_models" });
        pendingCommands.set(id, "get_available_models");
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
    sessions.detach(sessionId, listener);
  });

  ws.on("error", () => {
    sessions.detach(sessionId, listener);
  });
}

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
