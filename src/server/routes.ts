import { Router, json } from "express";
import { spawnSync } from "child_process";
import type { SessionManager } from "./session-manager.js";

export function createRouter(sessions: SessionManager): Router {
  const router = Router();
  const gitBranch = resolveGitBranch(sessions.cwd);
  router.use(json());

  // Health check
  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      activeSessions: sessions.activeCount,
      cwd: sessions.cwd,
      gitBranch,
    });
  });

  // List sessions
  router.get("/sessions", async (_req, res) => {
    const list = await sessions.listSessions();
    res.json({ sessions: list });
  });

  // SSE: live session activity updates (must precede /sessions/:id routes)
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

function resolveGitBranch(cwd: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (result.status !== 0) return undefined;

    const branch = result.stdout.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}
