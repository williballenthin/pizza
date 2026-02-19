import { Router, json } from "express";
import { stat } from "fs/promises";
import type { SessionManager } from "./session-manager.js";
import { listProjects } from "./project-registry.js";

export function createRouter(sessions: SessionManager): Router {
  const router = Router();
  router.use(json());

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      activeSessions: sessions.activeCount,
      sessionsRoot: sessions.sessionsRoot,
    });
  });

  router.get("/sessions", async (_req, res) => {
    const list = await sessions.listSessions();
    res.json({ sessions: list });
  });

  router.get("/sessions/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    const unsubscribe = sessions.onActivityChange((update) => {
      res.write(`data: ${JSON.stringify(update)}\n\n`);
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.post("/sessions", async (req, res) => {
    const cwd = req.body?.cwd;
    if (typeof cwd !== "string" || !cwd) {
      res.status(400).json({ error: "Missing required field: cwd" });
      return;
    }
    try {
      const s = await stat(cwd);
      if (!s.isDirectory()) throw new Error("not a directory");
    } catch {
      res.status(400).json({ error: `Invalid directory: ${cwd}` });
      return;
    }
    try {
      const id = await sessions.createSession(cwd);
      res.status(201).json({ id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create session";
      console.error(`[POST /sessions] ${message}`);
      res.status(500).json({ error: message });
    }
  });

  router.patch("/sessions/:id", async (req, res) => {
    try {
      const result = await sessions.updateSession(req.params.id, req.body);
      if (!result) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update session";
      console.error(`[PATCH /sessions/${req.params.id}] ${message}`);
      res.status(500).json({ error: message });
    }
  });

  router.delete("/sessions/:id", async (req, res) => {
    try {
      const ok = await sessions.deleteSession(req.params.id);
      if (!ok) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete session";
      console.error(`[DELETE /sessions/${req.params.id}] ${message}`);
      res.status(500).json({ error: message });
    }
  });

  router.get("/projects", async (_req, res) => {
    const projects = await listProjects(sessions.sessionsRoot);
    res.json({ projects });
  });

  return router;
}
