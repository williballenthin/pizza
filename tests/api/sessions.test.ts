import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp, type AppInstance } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/server/config.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import type { AddressInfo } from "net";

function hasPi(): boolean {
  try {
    execSync("pi --version", { stdio: "ignore" });
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

describe("GET /api/health", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionDir: string;

  beforeAll(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "pi-web-test-"));
    const config: ServerConfig = {
      port: 0,
      sessionDir,
      cwd: sessionDir,
      defaultModel: null,
      defaultThinkingLevel: "off",
      idleTimeoutMs: 5000,
      piCommand: "pi",
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
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("returns status ok", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(typeof data.activeSessions).toBe("number");
  });
});

describe("Session listing from JSONL files", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionDir: string;

  beforeAll(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "pi-web-test-"));

    const id1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const id2 = "11111111-2222-3333-4444-555555555555";

    await writeFile(
      join(sessionDir, "2026-01-01T00-00-00_" + id1 + ".jsonl"),
      makeSessionJsonl(id1, {
        timestamp: "2026-01-01T00:00:00.000Z",
        name: "First Session",
        messages: [
          { role: "user", content: "Hello", timestamp: "2026-01-01T00:00:01.000Z" },
          { role: "assistant", content: "Hi!", timestamp: "2026-01-01T00:00:02.000Z" },
        ],
      }),
    );

    await writeFile(
      join(sessionDir, "2026-01-02T00-00-00_" + id2 + ".jsonl"),
      makeSessionJsonl(id2, {
        timestamp: "2026-01-02T00:00:00.000Z",
        messages: [
          { role: "user", content: "Tell me about TypeScript generics and how they work", timestamp: "2026-01-02T00:00:01.000Z" },
        ],
      }),
    );

    const config: ServerConfig = {
      port: 0,
      sessionDir,
      cwd: sessionDir,
      defaultModel: null,
      defaultThinkingLevel: "off",
      idleTimeoutMs: 5000,
      piCommand: "pi",
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
    await rm(sessionDir, { recursive: true, force: true });
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
    expect(s1.messageCount).toBe(2);
    expect(s1.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(s1.activity).toBeDefined();
    expect(typeof s1.activity.state).toBe("string");

    const s2 = data.sessions.find(
      (s: { id: string }) => s.id === "11111111-2222-3333-4444-555555555555",
    );
    expect(s2).toBeDefined();
    expect(s2.name).toBe("Tell me about TypeScript generics and how they work");
    expect(s2.messageCount).toBe(1);
  });

  it("sessions are sorted by lastActivityAt descending", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    const data = await res.json();
    expect(data.sessions[0].id).toBe("11111111-2222-3333-4444-555555555555");
    expect(data.sessions[1].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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

describe("Session CRUD with real pi", () => {
  if (!PI_AVAILABLE) {
    it.skip("pi not installed — skipping real session tests", () => {});
    return;
  }

  let app: AppInstance;
  let baseUrl: string;
  let sessionDir: string;
  let cwd: string;

  beforeAll(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "pi-web-test-sessions-"));
    cwd = await mkdtemp(join(tmpdir(), "pi-web-test-cwd-"));

    const config: ServerConfig = {
      port: 0,
      sessionDir,
      cwd,
      defaultModel: null,
      defaultThinkingLevel: "off",
      idleTimeoutMs: 30000,
      piCommand: "pi",
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
    await rm(sessionDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  let createdId: string;

  it("POST /api/sessions creates a session with UUID", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
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
    expect(typeof session.messageCount).toBe("number");
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
  let sessionDir: string;

  beforeAll(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "pi-web-test-"));

    const id = "abcdef01-2345-6789-abcd-ef0123456789";
    await writeFile(
      join(sessionDir, "2026-01-01T00-00-00_" + id + ".jsonl"),
      makeSessionJsonl(id, {
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );

    const config: ServerConfig = {
      port: 0,
      sessionDir,
      cwd: sessionDir,
      defaultModel: null,
      defaultThinkingLevel: "off",
      idleTimeoutMs: 5000,
      piCommand: "pi",
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
    await rm(sessionDir, { recursive: true, force: true });
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

describe("Session activity inference", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionDir: string;

  beforeAll(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "pi-web-test-activity-"));

    const recentId = "99999999-2222-3333-4444-555555555555";
    const recentIso = new Date(Date.now() - 2000).toISOString();

    await writeFile(
      join(sessionDir, "recent_" + recentId + ".jsonl"),
      makeSessionJsonl(recentId, {
        timestamp: recentIso,
        messages: [
          {
            role: "user",
            content: "recent external update",
            timestamp: recentIso,
          },
        ],
      }),
    );

    const config: ServerConfig = {
      port: 0,
      sessionDir,
      cwd: sessionDir,
      defaultModel: null,
      defaultThinkingLevel: "off",
      idleTimeoutMs: 15 * 60 * 1000,
      piCommand: "pi",
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
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("marks recently edited sessions without local activity as muted/elsewhere", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);

    const data = await res.json();
    const session = data.sessions.find(
      (s: { id: string }) => s.id === "99999999-2222-3333-4444-555555555555",
    );

    expect(session).toBeDefined();
    expect(session.activity.recentlyUpdated).toBe(true);
    expect(session.activity.activeHere).toBe(false);
    expect(session.activity.hasRecentClientActivity).toBe(false);
    expect(session.activity.muted).toBe(true);
    expect(session.activity.state).toBe("recently_edited_elsewhere");
  });
});
