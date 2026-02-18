import express from "express";
import { createServer as createHttpServer, type Server } from "http";
import { WebSocketServer } from "ws";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { SessionManager } from "./session-manager.js";
import { createRouter } from "./routes.js";
import { handleSessionWebSocket } from "./ws-handler.js";
import type { ServerConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppInstance {
  app: ReturnType<typeof express>;
  server: Server;
  sessions: SessionManager;
  wss: WebSocketServer;
  close: () => Promise<void>;
}

/**
 * Create the application (server + websocket) without starting it.
 * Useful for tests and programmatic usage.
 */
export function createApp(config: ServerConfig): AppInstance {
  const sessions = new SessionManager(config);
  const app = express();
  const server = createHttpServer(app);

  // REST API
  app.use("/api", createRouter(sessions));

  // Serve static frontend — prefer the built dist/client directory
  const projectRoot = resolve(__dirname, "..", "..");
  const distClientDir = resolve(projectRoot, "dist", "client");
  const srcClientDir = resolve(__dirname, "..", "client");
  const clientDir = existsSync(distClientDir) ? distClientDir : srcClientDir;
  if (existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.use((_req, res, next) => {
      if (_req.path.startsWith("/api")) return next();
      res.sendFile(resolve(clientDir, "index.html"));
    });
  }

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    const match = url.match(/^\/api\/sessions\/([^/]+)\/ws/);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleSessionWebSocket(ws, match[1], sessions).catch((err) => {
        console.error(`[ws] Session setup failed: ${err}`);
        ws.close(1011, "Session setup failed");
      });
    });
  });

  const close = (): Promise<void> => {
    return new Promise((resolve) => {
      sessions.shutdown();
      wss.close();
      // Close all existing connections before closing the server
      wss.clients.forEach((client) => client.terminate());
      server.closeAllConnections();
      server.close(() => resolve());
    });
  };

  return { app, server, sessions, wss, close };
}
