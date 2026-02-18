import { readdir, readFile, rm, mkdir, appendFile } from "fs/promises";
import { join } from "path";
import { RpcProcess } from "./rpc-process.js";
import type { SessionMeta, RpcEvent } from "@shared/types.js";
import type { ServerConfig } from "./config.js";

interface ActiveSession {
  rpc: RpcProcess;
  sessionId: string;
  sessionFile: string | undefined;
  name: string | undefined;
  createdAt: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  clients: Set<(event: RpcEvent) => void>;
}

interface ParsedSessionFile {
  file: string;
  id: string;
  createdAt: string;
  name: string | undefined;
  lastActivityAt: string;
  messageCount: number;
}

export class SessionManager {
  private active = new Map<string, ActiveSession>();
  private fileCache = new Map<string, ParsedSessionFile>();

  constructor(private config: ServerConfig) {}

  get activeCount(): number {
    return this.active.size;
  }

  async listSessions(): Promise<SessionMeta[]> {
    await mkdir(this.config.sessionDir, { recursive: true });

    const diskSessions = await this.scanSessionFiles();
    const seen = new Set<string>();
    const sessions: SessionMeta[] = [];

    for (const parsed of diskSessions) {
      seen.add(parsed.id);
      sessions.push({
        id: parsed.id,
        name: parsed.name || fallbackName(parsed.id),
        createdAt: parsed.createdAt,
        lastActivityAt: parsed.lastActivityAt,
        messageCount: parsed.messageCount,
      });
    }

    for (const [, entry] of this.active) {
      if (seen.has(entry.sessionId)) {
        if (entry.name) {
          const existing = sessions.find((s) => s.id === entry.sessionId);
          if (existing) existing.name = entry.name;
        }
      } else {
        sessions.push({
          id: entry.sessionId,
          name: entry.name || "New Session",
          createdAt: entry.createdAt,
          lastActivityAt: entry.createdAt,
          messageCount: 0,
        });
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
    };

    rpc.on("event", (event: RpcEvent) => {
      for (const client of entry.clients) {
        client(event);
      }
    });

    rpc.on("exit", () => {
      for (const client of entry.clients) {
        client({ type: "error", message: "RPC process exited" } as RpcEvent);
      }
    });

    rpc.on("error", (err: Error) => {
      console.error(`[session:${sessionId}] RPC error: ${err.message}`);
      for (const client of entry.clients) {
        client({
          type: "error",
          message: `RPC process error: ${err.message}`,
        } as RpcEvent);
      }
    });

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
      await active.rpc.sendAndWait({ type: "set_session_name", name: updates.name });
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
      } catch {
        return false;
      }
    }

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
    };

    rpc.on("event", (event: RpcEvent) => {
      for (const client of entry!.clients) {
        client(event);
      }
    });

    rpc.on("exit", () => {
      for (const client of entry!.clients) {
        client({ type: "error", message: "RPC process exited" } as RpcEvent);
      }
    });

    rpc.on("error", (err: Error) => {
      console.error(`[session:${sessionId}] RPC error: ${err.message}`);
      for (const client of entry!.clients) {
        client({
          type: "error",
          message: `RPC process error: ${err.message}`,
        } as RpcEvent);
      }
    });

    rpc.start();
    this.active.set(sessionId, entry);

    entry.clients.add(listener);
    return rpc;
  }

  detach(sessionId: string, listener: (event: RpcEvent) => void): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;

    entry.clients.delete(listener);

    if (entry.clients.size === 0) {
      this.startIdleTimer(sessionId, entry);
    }
  }

  shutdown(): void {
    for (const [, entry] of this.active) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.rpc.stop();
    }
    this.active.clear();
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
      if (
        val &&
        (key.endsWith("_API_KEY") || key.endsWith("_API_BASE"))
      ) {
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

    const results: ParsedSessionFile[] = [];
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const parsed = await this.parseSessionFile(file);
      if (parsed) results.push(parsed);
    }
    return results;
  }

  private async parseSessionFile(
    file: string,
  ): Promise<ParsedSessionFile | null> {
    const cached = this.fileCache.get(file);
    if (cached) return cached;

    const filePath = join(this.config.sessionDir, file);
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

    for (let i = 1; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.timestamp) lastTimestamp = entry.timestamp;

        if (entry.type === "session_info" && entry.name) {
          name = entry.name;
        } else if (entry.type === "message") {
          messageCount++;
          if (
            !firstUserMessage &&
            entry.message?.role === "user"
          ) {
            const text =
              typeof entry.message.content === "string"
                ? entry.message.content
                : Array.isArray(entry.message.content)
                  ? entry.message.content
                      .filter((c: { type: string }) => c.type === "text")
                      .map((c: { text: string }) => c.text)
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
    };

    this.fileCache.set(file, parsed);
    return parsed;
  }

  private async findSessionFile(sessionId: string): Promise<string | undefined> {
    const files = await this.scanSessionFiles();
    return files.find((f) => f.id === sessionId)?.file;
  }
}

function fallbackName(id: string): string {
  return `Session ${id.slice(0, 8)}`;
}

function randomHexId(): string {
  return Math.random().toString(16).slice(2, 10);
}
