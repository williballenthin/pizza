import { Router, json } from "express";
import type { SessionManager } from "./session-manager.js";

export function createRouter(sessions: SessionManager): Router {
  const router = Router();
  router.use(json());

  // Health check
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", activeSessions: sessions.activeCount });
  });

  // List sessions
  router.get("/sessions", async (_req, res) => {
    const list = await sessions.listSessions();
    res.json({ sessions: list });
  });

  // Create session
  router.post("/sessions", async (_req, res) => {
    try {
      const id = await sessions.createSession();
      res.status(201).json({ id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create session";
      console.error(`[POST /sessions] ${message}`);
      res.status(500).json({ error: message });
    }
  });

  // Update session
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

  // Delete session
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

  return router;
}
