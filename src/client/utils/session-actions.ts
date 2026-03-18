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

export type GitFileStatus = "A" | "M" | "D" | "R" | "C" | "U" | "?";

export interface GitFileChange {
  status: GitFileStatus;
  path: string;
  oldPath?: string;
}

export interface GitStatusSnapshot {
  isRepo: boolean;
  branch: string;
  head: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  authoredAt: string;
  subject: string;
}

export async function fetchSessionInfo(sessionId: string): Promise<SessionInfo | null> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const session = await res.json();

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

export async function fetchSessionGitStatus(sessionId: string): Promise<GitStatusSnapshot | null> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/status`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      isRepo: data.isRepo === true,
      branch: typeof data.branch === "string" ? data.branch : "",
      head: typeof data.head === "string" ? data.head : "",
      staged: Array.isArray(data.staged) ? data.staged : [],
      unstaged: Array.isArray(data.unstaged) ? data.unstaged : [],
    };
  } catch {
    return null;
  }
}

export async function fetchSessionGitCommits(
  sessionId: string,
  limit = 16,
): Promise<GitCommitSummary[]> {
  try {
    const safeLimit = Math.max(1, Math.min(64, Math.floor(limit || 16)));
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/git/commits?limit=${safeLimit}`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.commits) ? data.commits : [];
  } catch {
    return [];
  }
}

export async function fetchSessionGitCommitFiles(
  sessionId: string,
  sha: string,
): Promise<GitFileChange[] | null> {
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/git/commits/${encodeURIComponent(sha)}/files`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.files) ? data.files : [];
  } catch {
    return null;
  }
}

export async function fetchSessionGitDiff(
  sessionId: string,
  options: {
    scope: "staged" | "unstaged" | "commit";
    path: string;
    sha?: string;
  },
): Promise<string | null> {
  try {
    const params = new URLSearchParams();
    params.set("scope", options.scope);
    params.set("path", options.path);
    if (options.sha) params.set("sha", options.sha);

    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/git/diff?${params.toString()}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.diff === "string" ? data.diff : "";
  } catch {
    return null;
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
