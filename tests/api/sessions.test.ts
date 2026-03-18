import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp, type AppInstance } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/server/config.js";
import { encodeCwd } from "../../src/server/config.js";
import { chmod, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import type { AddressInfo } from "net";

const CONFIGURED_PI_COMMAND = process.env.PI_COMMAND || "pi";

function hasPi(): boolean {
  try {
    execSync(`${CONFIGURED_PI_COMMAND} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PI_AVAILABLE = hasPi();

function makeSessionJsonl(
  id: string,
  opts: {
    timestamp?: string;
    name?: string;
    messages?: Array<{ role: string; content: string; timestamp?: string }>;
  } = {},
): string {
  const ts = opts.timestamp || new Date().toISOString();
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: ts,
      cwd: "/tmp/test",
    }),
  );

  let parentId: string | null = null;
  let entryIdx = 0;

  if (opts.messages) {
    for (const msg of opts.messages) {
      const entryId = `e${String(entryIdx++).padStart(7, "0")}`;
      lines.push(
        JSON.stringify({
          type: "message",
          id: entryId,
          parentId,
          timestamp: msg.timestamp || ts,
          message: { role: msg.role, content: msg.content },
        }),
      );
      parentId = entryId;
    }
  }

  if (opts.name) {
    const entryId = `e${String(entryIdx++).padStart(7, "0")}`;
    lines.push(
      JSON.stringify({
        type: "session_info",
        id: entryId,
        parentId,
        timestamp: ts,
        name: opts.name,
      }),
    );
  }

  return lines.join("\n") + "\n";
}

async function makeSessionsRoot(cwdDir: string): Promise<{ sessionsRoot: string; bucketDir: string }> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-web-test-root-"));
  const bucketName = encodeCwd(cwdDir);
  const bucketDir = join(sessionsRoot, bucketName);
  await mkdir(bucketDir, { recursive: true });
  return { sessionsRoot, bucketDir };
}

async function makeFakePiCommand(): Promise<{ command: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-fake-pi-"));
  const scriptName = process.platform === "win32" ? "fake-pi.cmd" : "fake-pi.sh";
  const command = join(dir, scriptName);

  if (process.platform === "win32") {
    await writeFile(command, "@echo off\r\ntimeout /t 30 /nobreak >nul\r\n");
  } else {
    await writeFile(command, "#!/usr/bin/env sh\nsleep 30\n");
    await chmod(command, 0o755);
  }

  return { command, dir };
}

async function rmWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EBUSY" ||
        attempt === 4
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

describe("GET /api/health", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let cwdDir: string;

  beforeAll(async () => {
    cwdDir = await mkdtemp(join(tmpdir(), "pi-web-cwd-"));
    const result = await makeSessionsRoot(cwdDir);
    sessionsRoot = result.sessionsRoot;
    const config: ServerConfig = {
      port: 0,
      sessionsRoot,
      idleTimeoutMs: 5000,
      piCommand: process.env.PI_COMMAND || "pi",
    };
    app = createApp(config);
    await new Promise<void>((resolve) => {
      app.server.listen(0, () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    await rmWithRetry(sessionsRoot);
    await rmWithRetry(cwdDir);
  });

  it("returns status ok", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(typeof data.activeSessions).toBe("number");
    expect(data.sessionsRoot).toBeDefined();
  });
});

describe("Session listing from JSONL files", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let cwdDir: string;
  let bucketDir: string;

  beforeAll(async () => {
    cwdDir = await mkdtemp(join(tmpdir(), "pi-web-cwd-"));
    const result = await makeSessionsRoot(cwdDir);
    sessionsRoot = result.sessionsRoot;
    bucketDir = result.bucketDir;

    const id1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const id2 = "11111111-2222-3333-4444-555555555555";

    const now = new Date();
    const ts1 = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const ts2 = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

    await writeFile(
      join(bucketDir, "2026-01-01T00-00-00_" + id1 + ".jsonl"),
      makeSessionJsonl(id1, {
        timestamp: ts1,
        name: "First Session",
        messages: [
          { role: "user", content: "Hello", timestamp: ts1 },
          { role: "assistant", content: "Hi!", timestamp: ts1 },
        ],
      }),
    );

    await writeFile(
      join(bucketDir, "2026-01-02T00-00-00_" + id2 + ".jsonl"),
      makeSessionJsonl(id2, {
        timestamp: ts2,
        messages: [
          { role: "user", content: "Tell me about TypeScript generics and how they work", timestamp: ts2 },
        ],
      }),
    );

    const config: ServerConfig = {
      port: 0,
      sessionsRoot,
      idleTimeoutMs: 5000,
      piCommand: process.env.PI_COMMAND || "pi",
    };
    app = createApp(config);
    await new Promise<void>((resolve) => {
      app.server.listen(0, () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    await rmWithRetry(sessionsRoot);
    await rmWithRetry(cwdDir);
  });

  it("lists sessions from JSONL files with correct metadata", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toHaveLength(2);

    const s1 = data.sessions.find(
      (s: { id: string }) => s.id === "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(s1).toBeDefined();
    expect(s1.name).toBe("First Session");
    expect(s1.messageStats).toEqual({
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      totalMessages: 2,
    });
    expect(s1.createdAt).toBeDefined();
    expect(s1.activity).toBeDefined();
    expect(typeof s1.activity.state).toBe("string");
    expect(s1.cwdRaw).toBe(cwdDir);

    const s2 = data.sessions.find(
      (s: { id: string }) => s.id === "11111111-2222-3333-4444-555555555555",
    );
    expect(s2).toBeDefined();
    expect(s2.name).toBe("Tell me about TypeScript generics and how they work");
    expect(s2.messageStats).toEqual({
      userMessages: 1,
      assistantMessages: 0,
      toolCalls: 0,
      totalMessages: 1,
    });
  });

  it("sessions are sorted by lastActivityAt descending", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    const data = await res.json();
    expect(data.sessions[0].id).toBe("11111111-2222-3333-4444-555555555555");
    expect(data.sessions[1].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("GET /api/sessions/:id returns metadata for a single session", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/11111111-2222-3333-4444-555555555555`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(data.name).toBe("Tell me about TypeScript generics and how they work");
    expect(data.cwdRaw).toBe(cwdDir);
  });

  it("DELETE removes a JSONL session", async () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const res = await fetch(`${baseUrl}/api/sessions/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    const listRes = await fetch(`${baseUrl}/api/sessions`);
    const data = await listRes.json();
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("PATCH renames a session by appending session_info", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const res = await fetch(`${baseUrl}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed Session" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Renamed Session");

    const listRes = await fetch(`${baseUrl}/api/sessions`);
    const listData = await listRes.json();
    expect(listData.sessions[0].name).toBe("Renamed Session");
  });

  it("PATCH returns 404 for unknown session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent-id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE returns 404 for unknown session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent-id`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("Session creation errors", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let cwdDir: string;

  beforeAll(async () => {
    cwdDir = await mkdtemp(join(tmpdir(), "pi-web-cwd-"));
    const result = await makeSessionsRoot(cwdDir);
    sessionsRoot = result.sessionsRoot;

    const config: ServerConfig = {
      port: 0,
      sessionsRoot,
      idleTimeoutMs: 5000,
      piCommand: "definitely-missing-pi-command",
    };
    app = createApp(config);
    await new Promise<void>((resolve) => {
      app.server.listen(0, () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    await rmWithRetry(sessionsRoot);
    await rmWithRetry(cwdDir);
  });

  it("returns 500 instead of crashing when pi cannot be spawned", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: cwdDir }),
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/spawn|RPC process/i);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
  });
});

describe("Session respawn cwd", () => {
  let app: AppInstance;
  let sessionsRoot: string;
  let cwdDir: string;
  let fakePiDir: string;

  beforeAll(async () => {
    cwdDir = await mkdtemp(join(tmpdir(), "pi-web-cwd-"));
    const result = await makeSessionsRoot(cwdDir);
    sessionsRoot = result.sessionsRoot;

    const sessionId = "12345678-1234-1234-1234-123456789abc";
    await writeFile(
      join(result.bucketDir, `seed_${sessionId}.jsonl`),
      makeSessionJsonl(sessionId, {
        timestamp: new Date().toISOString(),
      }),
    );

    const fakePi = await makeFakePiCommand();
    fakePiDir = fakePi.dir;

    const config: ServerConfig = {
      port: 0,
      sessionsRoot,
      idleTimeoutMs: 5000,
      piCommand: fakePi.command,
    };
    app = createApp(config);
  });

  afterAll(async () => {
    await app.close();
    await rmWithRetry(sessionsRoot);
    await rmWithRetry(cwdDir);
    await rmWithRetry(fakePiDir);
  });

  it("uses the session's stored cwd when respawning", async () => {
    const listener = () => {};
    const { cwd } = await app.sessions.getOrSpawn(
      "12345678-1234-1234-1234-123456789abc",
      listener,
    );

    expect(cwd).toBe(cwdDir);
    app.sessions.detach("12345678-1234-1234-1234-123456789abc", listener);
  });
});

describe("Session CRUD with real pi", () => {
  if (!PI_AVAILABLE) {
    it.skip("pi not installed — skipping real session tests", () => {});
    return;
  }

  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let cwdDir: string;

  beforeAll(async () => {
    cwdDir = await mkdtemp(join(tmpdir(), "pi-web-test-cwd-"));
    const result = await makeSessionsRoot(cwdDir);
    sessionsRoot = result.sessionsRoot;

    const config: ServerConfig = {
      port: 0,
      sessionsRoot,
      idleTimeoutMs: 30000,
      piCommand: process.env.PI_COMMAND || "pi",
    };
    app = createApp(config);
    await new Promise<void>((resolve) => {
      app.server.listen(0, () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    await rmWithRetry(sessionsRoot);
    await rmWithRetry(cwdDir);
  });

  let createdId: string;

  it("POST /api/sessions creates a session with UUID", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: cwdDir }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    createdId = data.id;
  });

  it("GET /api/sessions lists the new session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);

    const session = data.sessions.find(
      (s: { id: string }) => s.id === createdId,
    );
    expect(session).toBeDefined();
    expect(session.createdAt).toBeDefined();
    expect(session.lastActivityAt).toBeDefined();
    expect(session.messageStats).toBeDefined();
    expect(typeof session.messageStats.totalMessages).toBe("number");
  });

  it("PATCH /api/sessions/:id renames the session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Rename" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Test Rename");
  });

  it("DELETE /api/sessions/:id removes the session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${createdId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    const listRes = await fetch(`${baseUrl}/api/sessions`);
    const data = await listRes.json();
    const session = data.sessions.find(
      (s: { id: string }) => s.id === createdId,
    );
    expect(session).toBeUndefined();
  });
}, 30000);

describe("Session name fallbacks", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let cwdDir: string;
  let bucketDir: string;

  beforeAll(async () => {
    cwdDir = await mkdtemp(join(tmpdir(), "pi-web-cwd-"));
    const result = await makeSessionsRoot(cwdDir);
    sessionsRoot = result.sessionsRoot;
    bucketDir = result.bucketDir;

    const id = "abcdef01-2345-6789-abcd-ef0123456789";
    await writeFile(
      join(bucketDir, "fallback-test_" + id + ".jsonl"),
      makeSessionJsonl(id, {
        timestamp: new Date().toISOString(),
      }),
    );

    const config: ServerConfig = {
      port: 0,
      sessionsRoot,
      idleTimeoutMs: 5000,
      piCommand: process.env.PI_COMMAND || "pi",
    };
    app = createApp(config);
    await new Promise<void>((resolve) => {
      app.server.listen(0, () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    await rmWithRetry(sessionsRoot);
    await rmWithRetry(cwdDir);
  });

  it("uses UUID-based fallback name when no name or messages", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    const data = await res.json();
    const session = data.sessions.find(
      (s: { id: string }) => s.id === "abcdef01-2345-6789-abcd-ef0123456789",
    );
    expect(session).toBeDefined();
    expect(session.name).toBe("Session abcdef01");
  });
});
