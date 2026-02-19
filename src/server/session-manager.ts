import { readdir, readFile, rm, mkdir, appendFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { RpcProcess } from "./rpc-process.js";
import type {
  SessionMeta,
  SessionMessageStats,
  SessionActivityUpdate,
  RpcEvent,
  SessionActivityState,
  AgentMessageData,
} from "@shared/types.js";
import { countMessageStats, emptyMessageStats, type JsonlMessageEntry } from "@shared/session-stats.js";
import type { ServerConfig } from "./config.js";
import { encodeCwd } from "./config.js";
import { decodeCwd } from "./project-registry.js";

interface ActiveSession {
  rpc: RpcProcess;
  sessionId: string;
  sessionFile: string | undefined;
  bucketDir: string;
  cwd: string;
  name: string | undefined;
  createdAt: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  clients: Set<(event: RpcEvent) => void>;
  isAgentWorking: boolean;
}

interface ParsedSessionFile {
  file: string;
  bucketDir: string;
  id: string;
  createdAt: string;
  name: string | undefined;
  lastActivityAt: string;
  messageStats: SessionMessageStats;
  model: string | undefined;
  cwd: string;
}

interface CachedParsedSessionFile {
  parsed: ParsedSessionFile;
  mtimeMs: number;
  size: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class SessionManager {
  private active = new Map<string, ActiveSession>();
  private fileCache = new Map<string, CachedParsedSessionFile>();
  private sessionFileById = new Map<string, { bucketDir: string; file: string }>();
  private sessionIdByFile = new Map<string, string>();
  private recentClientActivityAt = new Map<string, number>();
  private activityListeners = new Set<(update: SessionActivityUpdate) => void>();

  constructor(private config: ServerConfig) {}

  get activeCount(): number {
    return this.active.size;
  }

  get sessionsRoot(): string {
    return this.config.sessionsRoot;
  }

  async listSessions(): Promise<SessionMeta[]> {
    const now = Date.now();
    this.pruneRecentClientActivity(now);

    const diskSessions = await this.scanAllBuckets();
    const seen = new Set<string>();
    const sessions: SessionMeta[] = [];

    for (const parsed of diskSessions) {
      if (Date.now() - Date.parse(parsed.lastActivityAt) > SEVEN_DAYS_MS) continue;
      seen.add(parsed.id);

      const home = homedir();
      const cwdDisplay = parsed.cwd.startsWith(home)
        ? "~" + parsed.cwd.slice(home.length)
        : parsed.cwd;

      sessions.push(
        this.decorateWithActivity(
          {
            id: parsed.id,
            name: parsed.name || fallbackName(parsed.id),
            createdAt: parsed.createdAt,
            lastActivityAt: parsed.lastActivityAt,
            messageStats: parsed.messageStats,
            model: parsed.model,
            cwd: cwdDisplay,
            cwdRaw: parsed.cwd,
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
        const home = homedir();
        const cwdDisplay = entry.cwd.startsWith(home)
          ? "~" + entry.cwd.slice(home.length)
          : entry.cwd;

        sessions.push(
          this.decorateWithActivity(
            {
              id: entry.sessionId,
              name: entry.name || "New Session",
              createdAt: entry.createdAt,
              lastActivityAt: entry.createdAt,
              messageStats: emptyMessageStats(),
              cwd: cwdDisplay,
              cwdRaw: entry.cwd,
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

  async createSession(cwd: string): Promise<string> {
    const bucketDir = join(this.config.sessionsRoot, encodeCwd(cwd));
    await mkdir(bucketDir, { recursive: true });

    const env = this.buildEnv();
    const rpc = new RpcProcess(
      this.config.piCommand,
      cwd,
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
      bucketDir,
      cwd,
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

    const loc = await this.findSessionFile(id);
    if (!loc) return null;

    const infoEntry = {
      type: "session_info",
      id: randomHexId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      name: updates.name,
    };
    await appendFile(
      join(loc.bucketDir, loc.file),
      JSON.stringify(infoEntry) + "\n",
    );

    const cacheKey = loc.bucketDir + "/" + loc.file;
    this.fileCache.delete(cacheKey);

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

    const loc = await this.findSessionFile(id);
    if (!loc && !active) return false;

    if (loc) {
      const filePath = join(loc.bucketDir, loc.file);
      try {
        await rm(filePath, { force: true });
        const cacheKey = loc.bucketDir + "/" + loc.file;
        this.fileCache.delete(cacheKey);
        const mappedId = this.sessionIdByFile.get(cacheKey);
        this.sessionIdByFile.delete(cacheKey);
        if (mappedId && this.sessionFileById.get(mappedId)?.file === loc.file) {
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
  ): Promise<{ rpc: RpcProcess; cwd: string }> {
    let entry = this.active.get(sessionId);

    if (entry && entry.rpc.alive) {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      entry.clients.add(listener);
      this.noteClientActivity(sessionId);
      this.broadcastActivity(sessionId);
      return { rpc: entry.rpc, cwd: entry.cwd };
    }

    const loc = await this.findSessionFile(sessionId);
    const cwd = loc ? (await decodeCwd(loc.bucketDir.split("/").pop()!) ?? process.cwd()) : process.cwd();
    const bucketDir = loc ? loc.bucketDir : join(this.config.sessionsRoot, encodeCwd(cwd));

    const env = this.buildEnv();
    const rpc = new RpcProcess(
      this.config.piCommand,
      cwd,
      loc ? join(loc.bucketDir, loc.file) : undefined,
      env,
    );

    entry = {
      rpc,
      sessionId,
      sessionFile: loc?.file,
      bucketDir,
      cwd,
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
    return { rpc, cwd };
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

  private async scanAllBuckets(): Promise<ParsedSessionFile[]> {
    let rootEntries: string[];
    try {
      rootEntries = await readdir(this.config.sessionsRoot);
    } catch {
      return [];
    }

    const buckets = rootEntries.filter(e => e.startsWith("--") && e.endsWith("--"));
    const results: ParsedSessionFile[] = [];

    for (const bucket of buckets) {
      const bucketPath = join(this.config.sessionsRoot, bucket);
      const cwd = await decodeCwd(bucket);
      if (!cwd) continue;

      let entries: string[];
      try {
        entries = await readdir(bucketPath);
      } catch {
        continue;
      }

      const jsonlFiles = entries.filter(f => f.endsWith(".jsonl"));

      const existingKeys = new Set(jsonlFiles.map(f => bucketPath + "/" + f));
      for (const key of Array.from(this.fileCache.keys())) {
        if (key.startsWith(bucketPath + "/") && !existingKeys.has(key)) {
          this.fileCache.delete(key);
        }
      }

      for (const [fileKey, id] of Array.from(this.sessionIdByFile.entries())) {
        if (fileKey.startsWith(bucketPath + "/") && !existingKeys.has(fileKey)) {
          this.sessionIdByFile.delete(fileKey);
          const loc = this.sessionFileById.get(id);
          if (loc && loc.bucketDir === bucketPath) {
            this.sessionFileById.delete(id);
          }
        }
      }

      for (const file of jsonlFiles) {
        const parsed = await this.parseSessionFile(file, bucketPath, cwd);
        if (parsed) results.push(parsed);
      }
    }

    return results;
  }

  private async parseSessionFile(
    file: string,
    bucketDir: string,
    cwd: string,
  ): Promise<ParsedSessionFile | null> {
    const filePath = join(bucketDir, file);
    const cacheKey = bucketDir + "/" + file;

    let fileStat: { mtimeMs: number; size: number };
    try {
      const stats = await stat(filePath);
      fileStat = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }

    const cached = this.fileCache.get(cacheKey);
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
    const messageEntries: JsonlMessageEntry[] = [];
    let firstUserMessage: string | undefined;
    let model: string | undefined;

    for (let i = 1; i < lines.length; i++) {
      try {
        const parsedLine = JSON.parse(lines[i]) as {
          type?: string;
          timestamp?: string;
          name?: string;
          modelId?: string;
          message?: {
            role?: string;
            content?: string | Array<{ type: string; text?: string }>;
          };
        };

        if (parsedLine.timestamp) lastTimestamp = parsedLine.timestamp;

        if (parsedLine.type === "model_change" && parsedLine.modelId) {
          model = parsedLine.modelId as string;
        }

        if (parsedLine.type === "session_info" && parsedLine.name) {
          name = parsedLine.name;
        } else if (parsedLine.type === "message") {
          if (parsedLine.message) {
            messageEntries.push({
              role: parsedLine.message.role || "",
              content: parsedLine.message.content,
            });
          }
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
      bucketDir,
      id: header.id,
      createdAt: header.timestamp || new Date().toISOString(),
      name,
      lastActivityAt: lastTimestamp,
      messageStats: countMessageStats(messageEntries),
      model,
      cwd,
    };

    const previousIdForFile = this.sessionIdByFile.get(cacheKey);
    if (previousIdForFile && previousIdForFile !== parsed.id) {
      this.sessionFileById.delete(previousIdForFile);
    }
    this.sessionIdByFile.set(cacheKey, parsed.id);
    this.sessionFileById.set(parsed.id, { bucketDir, file });

    this.fileCache.set(cacheKey, {
      parsed,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    });

    return parsed;
  }

  private async findSessionFile(sessionId: string): Promise<{ bucketDir: string; file: string } | undefined> {
    const cached = this.sessionFileById.get(sessionId);
    if (cached) {
      const parsed = await this.parseSessionFile(cached.file, cached.bucketDir, "");
      if (parsed?.id === sessionId) {
        return cached;
      }
      this.sessionFileById.delete(sessionId);
      const cacheKey = cached.bucketDir + "/" + cached.file;
      if (this.sessionIdByFile.get(cacheKey) === sessionId) {
        this.sessionIdByFile.delete(cacheKey);
      }
    }

    const files = await this.scanAllBuckets();
    const match = files.find((f) => f.id === sessionId);
    if (!match) return undefined;
    return { bucketDir: match.bucketDir, file: match.file };
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
    const loc = await this.findSessionFile(sessionId);
    if (!loc) return [];

    const filePath = join(loc.bucketDir, loc.file);
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

      let leaf = entries[entries.length - 1];
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
    const loc = await this.findSessionFile(sessionId);
    if (!loc) return;

    const entry = {
      type: "custom_message",
      id: randomHexId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      customType,
      content,
      display: true,
      details,
    };

    await appendFile(
      join(loc.bucketDir, loc.file),
      JSON.stringify(entry) + "\n",
    );

    const cacheKey = loc.bucketDir + "/" + loc.file;
    this.fileCache.delete(cacheKey);
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
