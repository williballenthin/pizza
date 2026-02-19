import { readdir, readFile, rm, mkdir, appendFile, stat } from "fs/promises";
import { join } from "path";
import { RpcProcess } from "./rpc-process.js";
import type {
  SessionMeta,
  SessionActivityUpdate,
  RpcEvent,
  SessionActivityState,
  AgentMessageData,
} from "@shared/types.js";
import type { ServerConfig } from "./config.js";

interface ActiveSession {
  rpc: RpcProcess;
  sessionId: string;
  sessionFile: string | undefined;
  name: string | undefined;
  createdAt: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  clients: Set<(event: RpcEvent) => void>;
  isAgentWorking: boolean;
}

interface ParsedSessionFile {
  file: string;
  id: string;
  createdAt: string;
  name: string | undefined;
  lastActivityAt: string;
  messageCount: number;
  model: string | undefined;
}

interface CachedParsedSessionFile {
  parsed: ParsedSessionFile;
  mtimeMs: number;
  size: number;
}

export class SessionManager {
  private active = new Map<string, ActiveSession>();
  private fileCache = new Map<string, CachedParsedSessionFile>();
  private sessionFileById = new Map<string, string>();
  private sessionIdByFile = new Map<string, string>();
  private recentClientActivityAt = new Map<string, number>();
  private activityListeners = new Set<(update: SessionActivityUpdate) => void>();

  constructor(private config: ServerConfig) {}

  get activeCount(): number {
    return this.active.size;
  }

  get cwd(): string {
    return this.config.cwd;
  }

  async listSessions(): Promise<SessionMeta[]> {
    await mkdir(this.config.sessionDir, { recursive: true });

    const now = Date.now();
    this.pruneRecentClientActivity(now);

    const diskSessions = await this.scanSessionFiles();
    const seen = new Set<string>();
    const sessions: SessionMeta[] = [];

    for (const parsed of diskSessions) {
      seen.add(parsed.id);
      sessions.push(
        this.decorateWithActivity(
          {
            id: parsed.id,
            name: parsed.name || fallbackName(parsed.id),
            createdAt: parsed.createdAt,
            lastActivityAt: parsed.lastActivityAt,
            messageCount: parsed.messageCount,
            model: parsed.model,
          },
          now,
        ),
      );
    }

    for (const [, entry] of this.active) {
      if (seen.has(entry.sessionId)) {
        const existing = sessions.find((s) => s.id === entry.sessionId);
        if (existing) {
          if (entry.name) existing.name = entry.name;
          existing.activity = this.computeActivity(existing, now);
        }
      } else {
        sessions.push(
          this.decorateWithActivity(
            {
              id: entry.sessionId,
              name: entry.name || "New Session",
              createdAt: entry.createdAt,
              lastActivityAt: entry.createdAt,
              messageCount: 0,
            },
            now,
          ),
        );
      }
    }

    sessions.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    );

    return sessions;
  }

  async createSession(): Promise<string> {
    const env = this.buildEnv();
    const rpc = new RpcProcess(
      this.config.piCommand,
      this.config.cwd,
      undefined,
      env,
    );

    rpc.start();

    const response = await rpc.sendAndWait({ type: "get_state" }, 15000);
    const data = response.data as { sessionId: string; sessionFile?: string };
    const sessionId = data.sessionId;
    const sessionFile = data.sessionFile;

    const entry: ActiveSession = {
      rpc,
      sessionId,
      sessionFile,
      name: undefined,
      createdAt: new Date().toISOString(),
      idleTimer: null,
      clients: new Set(),
      isAgentWorking: false,
    };

    this.bindRpcHandlers(entry);

    this.startIdleTimer(sessionId, entry);
    this.active.set(sessionId, entry);

    return sessionId;
  }

  async updateSession(
    id: string,
    updates: { name?: string },
  ): Promise<SessionMeta | null> {
    if (updates.name === undefined) return null;

    const active = this.active.get(id);
    if (active && active.rpc.alive) {
      await active.rpc.sendAndWait({
        type: "set_session_name",
        name: updates.name,
      });
      active.name = updates.name;
      this.fileCache.clear();
      const sessions = await this.listSessions();
      return sessions.find((s) => s.id === id) || null;
    }

    const sessionFile = await this.findSessionFile(id);
    if (!sessionFile) return null;

    const infoEntry = {
      type: "session_info",
      id: randomHexId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      name: updates.name,
    };
    await appendFile(
      join(this.config.sessionDir, sessionFile),
      JSON.stringify(infoEntry) + "\n",
    );

    this.fileCache.delete(sessionFile);

    const sessions = await this.listSessions();
    return sessions.find((s) => s.id === id) || null;
  }

  async deleteSession(id: string): Promise<boolean> {
    const active = this.active.get(id);
    if (active) {
      active.rpc.stop();
      if (active.idleTimer) clearTimeout(active.idleTimer);
      this.active.delete(id);
    }

    const sessionFile = await this.findSessionFile(id);
    if (!sessionFile && !active) return false;

    if (sessionFile) {
      const filePath = join(this.config.sessionDir, sessionFile);
      try {
        await rm(filePath, { force: true });
        this.fileCache.delete(sessionFile);
        const mappedId = this.sessionIdByFile.get(sessionFile);
        this.sessionIdByFile.delete(sessionFile);
        if (mappedId && this.sessionFileById.get(mappedId) === sessionFile) {
          this.sessionFileById.delete(mappedId);
        }
      } catch {
        return false;
      }
    }

    this.recentClientActivityAt.delete(id);
    return true;
  }

  async getOrSpawn(
    sessionId: string,
    listener: (event: RpcEvent) => void,
  ): Promise<RpcProcess> {
    let entry = this.active.get(sessionId);

    if (entry && entry.rpc.alive) {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      entry.clients.add(listener);
      this.noteClientActivity(sessionId);
      this.broadcastActivity(sessionId);
      return entry.rpc;
    }

    const sessionFile = await this.findSessionFile(sessionId);
    const env = this.buildEnv();
    const rpc = new RpcProcess(
      this.config.piCommand,
      this.config.cwd,
      sessionFile ? join(this.config.sessionDir, sessionFile) : undefined,
      env,
    );

    entry = {
      rpc,
      sessionId,
      sessionFile,
      name: undefined,
      createdAt: new Date().toISOString(),
      idleTimer: null,
      clients: new Set(),
      isAgentWorking: false,
    };

    this.bindRpcHandlers(entry);

    rpc.start();
    this.active.set(sessionId, entry);

    entry.clients.add(listener);
    this.noteClientActivity(sessionId);
    this.broadcastActivity(sessionId);
    return rpc;
  }

  detach(sessionId: string, listener: (event: RpcEvent) => void): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;

    const hadListener = entry.clients.delete(listener);
    if (hadListener) {
      this.noteClientActivity(sessionId);
      this.broadcastActivity(sessionId);
    }

    if (entry.clients.size === 0) {
      if (!entry.isAgentWorking) {
        this.startIdleTimer(sessionId, entry);
      }
    }
  }

  shutdown(): void {
    for (const [, entry] of this.active) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.rpc.stop();
    }
    this.active.clear();
  }

  onActivityChange(listener: (update: SessionActivityUpdate) => void): () => void {
    this.activityListeners.add(listener);
    return () => { this.activityListeners.delete(listener); };
  }

  private broadcastActivity(sessionId: string): void {
    if (this.activityListeners.size === 0) return;
    const meta = { id: sessionId, lastActivityAt: new Date().toISOString() };
    const activity = this.computeActivity(meta, Date.now());
    const update: SessionActivityUpdate = { sessionId, activity };
    for (const listener of this.activityListeners) {
      listener(update);
    }
  }

  private bindRpcHandlers(entry: ActiveSession): void {
    const sessionId = entry.sessionId;

    entry.rpc.on("event", (event: RpcEvent) => {
      if (event.type === "agent_start" || event.type === "turn_start") {
        entry.isAgentWorking = true;
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        this.broadcastActivity(sessionId);
      } else if (event.type === "turn_end") {
        entry.isAgentWorking = false;
        if (entry.clients.size === 0) {
          this.startIdleTimer(sessionId, entry);
        }
        this.broadcastActivity(sessionId);
      }

      if (entry.clients.size > 0) {
        this.noteClientActivity(sessionId);
      }
      for (const client of entry.clients) {
        client(event);
      }
    });

    entry.rpc.on("exit", () => {
      for (const client of entry.clients) {
        client({ type: "error", message: "RPC process exited" } as RpcEvent);
      }
      this.active.delete(sessionId);
      this.broadcastActivity(sessionId);
    });

    entry.rpc.on("error", (err: Error) => {
      console.error(`[session:${sessionId}] RPC error: ${err.message}`);
      for (const client of entry.clients) {
        client({
          type: "error",
          message: `RPC process error: ${err.message}`,
        } as RpcEvent);
      }
    });
  }

  private startIdleTimer(sessionId: string, entry: ActiveSession): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.rpc.stop();
      this.active.delete(sessionId);
    }, this.config.idleTimeoutMs);
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val && (key.endsWith("_API_KEY") || key.endsWith("_API_BASE"))) {
        env[key] = val;
      }
    }
    return env;
  }

  private async scanSessionFiles(): Promise<ParsedSessionFile[]> {
    let entries: string[];
    try {
      entries = await readdir(this.config.sessionDir);
    } catch {
      return [];
    }

    const jsonlFiles = entries.filter((file) => file.endsWith(".jsonl"));
    const existingFiles = new Set(jsonlFiles);

    for (const file of Array.from(this.fileCache.keys())) {
      if (!existingFiles.has(file)) {
        this.fileCache.delete(file);
      }
    }

    for (const [file, id] of Array.from(this.sessionIdByFile.entries())) {
      if (!existingFiles.has(file)) {
        this.sessionIdByFile.delete(file);
        if (this.sessionFileById.get(id) === file) {
          this.sessionFileById.delete(id);
        }
      }
    }

    const results: ParsedSessionFile[] = [];
    for (const file of jsonlFiles) {
      const parsed = await this.parseSessionFile(file);
      if (parsed) results.push(parsed);
    }
    return results;
  }

  private async parseSessionFile(
    file: string,
  ): Promise<ParsedSessionFile | null> {
    const filePath = join(this.config.sessionDir, file);

    let fileStat: { mtimeMs: number; size: number };
    try {
      const stats = await stat(filePath);
      fileStat = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }

    const cached = this.fileCache.get(file);
    if (
      cached &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.size === fileStat.size
    ) {
      return cached.parsed;
    }

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    let header: { type: string; id?: string; timestamp?: string };
    try {
      header = JSON.parse(lines[0]);
    } catch {
      return null;
    }

    if (header.type !== "session" || !header.id) return null;

    let name: string | undefined;
    let lastTimestamp = header.timestamp || new Date().toISOString();
    let messageCount = 0;
    let firstUserMessage: string | undefined;
    let model: string | undefined;

    for (let i = 1; i < lines.length; i++) {
      try {
        const parsedLine = JSON.parse(lines[i]) as {
          type?: string;
          timestamp?: string;
          name?: string;
          model?: {
            id: string;
            provider: string;
          };
          message?: {
            role?: string;
            content?: string | Array<{ type: string; text?: string }>;
          };
        };

        if (parsedLine.timestamp) lastTimestamp = parsedLine.timestamp;

        if (parsedLine.type === "state" && parsedLine.model) {
          model = parsedLine.model.id;
        }

        if (parsedLine.type === "session_info" && parsedLine.name) {
          name = parsedLine.name;
        } else if (parsedLine.type === "message") {
          messageCount++;
          if (!firstUserMessage && parsedLine.message?.role === "user") {
            const text =
              typeof parsedLine.message.content === "string"
                ? parsedLine.message.content
                : Array.isArray(parsedLine.message.content)
                  ? parsedLine.message.content
                      .filter((c) => c.type === "text")
                      .map((c) => c.text || "")
                      .join(" ")
                  : "";
            if (text) firstUserMessage = text;
          }
        }
      } catch {
        continue;
      }
    }

    if (!name && firstUserMessage) {
      name = firstUserMessage.slice(0, 60).replace(/\n/g, " ").trim();
      if (firstUserMessage.length > 60) name += "…";
    }

    const parsed: ParsedSessionFile = {
      file,
      id: header.id,
      createdAt: header.timestamp || new Date().toISOString(),
      name,
      lastActivityAt: lastTimestamp,
      messageCount,
      model,
    };

    const previousIdForFile = this.sessionIdByFile.get(file);
    if (previousIdForFile && previousIdForFile !== parsed.id) {
      this.sessionFileById.delete(previousIdForFile);
    }
    this.sessionIdByFile.set(file, parsed.id);
    this.sessionFileById.set(parsed.id, file);

    this.fileCache.set(file, {
      parsed,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    });

    return parsed;
  }

  private async findSessionFile(sessionId: string): Promise<string | undefined> {
    const cachedFile = this.sessionFileById.get(sessionId);
    if (cachedFile) {
      const parsed = await this.parseSessionFile(cachedFile);
      if (parsed?.id === sessionId) {
        return cachedFile;
      }

      this.sessionFileById.delete(sessionId);
      if (this.sessionIdByFile.get(cachedFile) === sessionId) {
        this.sessionIdByFile.delete(cachedFile);
      }
    }

    const files = await this.scanSessionFiles();
    return files.find((f) => f.id === sessionId)?.file;
  }

  private decorateWithActivity(meta: Omit<SessionMeta, "activity">, now: number): SessionMeta {
    return {
      ...meta,
      activity: this.computeActivity(meta, now),
    };
  }

  private computeActivity(
    meta: Pick<SessionMeta, "id" | "lastActivityAt">,
    now: number,
  ): SessionMeta["activity"] {
    const activeEntry = this.active.get(meta.id);
    const activeHere = !!activeEntry?.rpc.alive;
    const isWorking = !!activeEntry?.isAgentWorking;
    const attached = activeHere && activeEntry.clients.size > 0;
    const hasRecentClientActivity =
      attached || this.hasRecentClientActivity(meta.id, now);

    const idle = activeHere && !attached && hasRecentClientActivity;
    const warm = !activeHere && hasRecentClientActivity;
    const recentlyUpdated = this.isRecentlyUpdated(meta.lastActivityAt, now);

    const state: SessionActivityState = attached
      ? "attached"
      : idle
        ? "idle"
        : activeHere
          ? "active_here"
          : warm
            ? "warm"
            : "inactive";

    return {
      state,
      activeHere,
      attached,
      idle,
      warm,
      hasRecentClientActivity,
      recentlyUpdated,
      isWorking,
    };
  }

  private isRecentlyUpdated(lastActivityAt: string, now: number): boolean {
    const lastActivityMs = Date.parse(lastActivityAt);
    if (!Number.isFinite(lastActivityMs)) return false;
    return now - lastActivityMs <= this.config.idleTimeoutMs;
  }

  private noteClientActivity(sessionId: string): void {
    this.recentClientActivityAt.set(sessionId, Date.now());
  }

  private hasRecentClientActivity(sessionId: string, now: number): boolean {
    const last = this.recentClientActivityAt.get(sessionId);
    if (!last) return false;
    if (now - last > this.config.idleTimeoutMs) {
      this.recentClientActivityAt.delete(sessionId);
      return false;
    }
    return true;
  }

  async getHistory(sessionId: string): Promise<AgentMessageData[]> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return [];

    const filePath = join(this.config.sessionDir, sessionFile);
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const byId = new Map<string, any>();
      const entries: any[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.id) {
            byId.set(entry.id, entry);
            entries.push(entry);
          }
        } catch {
          continue;
        }
      }

      if (entries.length === 0) return [];

      // Find the last message or compaction as our leaf
      let leaf = entries[entries.length - 1];
      // Walk from leaf to root to get the current branch path
      const path: any[] = [];
      let current = leaf;
      while (current) {
        path.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : null;
      }

      const messages: AgentMessageData[] = [];
      for (const entry of path) {
        if (entry.type === "message" && entry.message) {
          messages.push({ ...entry.message, id: entry.id });
        } else if (entry.type === "compaction" && entry.summary) {
          messages.push({
            role: "compactionSummary",
            summary: entry.summary,
            tokensBefore: entry.tokensBefore,
            timestamp: new Date(entry.timestamp).getTime(),
            id: entry.id,
          } as AgentMessageData);
        } else if (entry.type === "custom_message") {
          messages.push({
            role: "custom",
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
            timestamp: new Date(entry.timestamp).getTime(),
            id: entry.id,
          } as AgentMessageData);
        } else if (entry.type === "branch_summary" && entry.summary) {
          messages.push({
            role: "branchSummary",
            summary: entry.summary,
            fromId: entry.fromId,
            timestamp: new Date(entry.timestamp).getTime(),
            id: entry.id,
          } as AgentMessageData);
        }
      }
      return messages;
    } catch (e) {
      console.error(`Failed to read history for session ${sessionId}:`, e);
      return [];
    }
  }

  async addCustomMessage(
    sessionId: string,
    customType: string,
    content: string,
    details?: any,
  ): Promise<void> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return;

    const entry = {
      type: "custom_message",
      id: randomHexId(),
      parentId: null, // We don't easily know the parentId here
      timestamp: new Date().toISOString(),
      customType,
      content,
      display: true,
      details,
    };

    await appendFile(
      join(this.config.sessionDir, sessionFile),
      JSON.stringify(entry) + "\n",
    );

    this.fileCache.delete(sessionFile);
  }

  private pruneRecentClientActivity(now: number): void {
    for (const [sessionId, timestamp] of this.recentClientActivityAt) {
      if (now - timestamp > this.config.idleTimeoutMs) {
        this.recentClientActivityAt.delete(sessionId);
      }
    }
  }

}

function fallbackName(id: string): string {
  return `Session ${id.slice(0, 8)}`;
}

function randomHexId(): string {
  return Math.random().toString(16).slice(2, 10);
}
