import { isArchivedSessionName, unarchiveSessionName } from "@shared/session-archive.js";
import type { SessionMessageStats } from "@shared/types.js";
import { emptyMessageStats } from "@shared/session-stats.js";

export interface SessionInfo {
  name: string;
  createdAt: string;
  lastActivityAt: string;
  messageStats: SessionMessageStats;
  cwd?: string;
}

export interface RuntimeInfo {
  sessionsRoot: string;
}

export interface ProjectInfo {
  cwd: string;
  encodedCwd: string;
  sessionDir: string;
  sessionCount: number;
  lastActivityAt: string;
  displayPath: string;
}

export async function fetchSessionInfo(sessionId: string): Promise<SessionInfo | null> {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) return null;
    const data = await res.json();
    const session = data.sessions.find((s: any) => s.id === sessionId);
    if (!session) return null;

    return {
      name: session.name || "Session",
      createdAt: session.createdAt || "",
      lastActivityAt: session.lastActivityAt || "",
      messageStats: session.messageStats || emptyMessageStats(),
      cwd: typeof session.cwd === "string" ? session.cwd : undefined,
    };
  } catch {
    return null;
  }
}

export async function fetchRuntimeInfo(): Promise<RuntimeInfo | null> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return null;
    const data = await res.json();
    return {
      sessionsRoot: typeof data.sessionsRoot === "string" ? data.sessionsRoot : "",
    };
  } catch {
    return null;
  }
}

export async function fetchProjects(): Promise<ProjectInfo[]> {
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) return [];
    const data = await res.json();
    return data.projects || [];
  } catch {
    return [];
  }
}

export async function patchSessionName(sessionId: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function unarchiveSessionIfNeeded(
  sessionId: string,
  currentName: string
): Promise<string | null> {
  if (!isArchivedSessionName(currentName)) return null;

  const nextName = unarchiveSessionName(currentName).trim() || "Session";
  const success = await patchSessionName(sessionId, nextName);
  return success ? nextName : null;
}
