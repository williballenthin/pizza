import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp, type AppInstance } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/server/config.js";
import { encodeCwd } from "../../src/server/config.js";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";

function makeSessionJsonl(id: string, timestamp: string): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/tmp/test" }) + "\n";
}

describe("GET /api/projects", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let projectDir1: string;
  let projectDir2: string;

  beforeAll(async () => {
    sessionsRoot = await mkdtemp(join(tmpdir(), "pi-web-proj-test-"));
    projectDir1 = await mkdtemp(join(tmpdir(), "proj1-"));
    projectDir2 = await mkdtemp(join(tmpdir(), "proj2-"));

    const bucket1 = join(sessionsRoot, encodeCwd(projectDir1));
    const bucket2 = join(sessionsRoot, encodeCwd(projectDir2));
    await mkdir(bucket1, { recursive: true });
    await mkdir(bucket2, { recursive: true });

    const now = new Date();
    const ts1 = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const ts2 = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    const f1 = join(bucket1, "s1.jsonl");
    await writeFile(f1, makeSessionJsonl("s1", ts1.toISOString()));
    await utimes(f1, ts1, ts1);

    const f2 = join(bucket2, "s2.jsonl");
    await writeFile(f2, makeSessionJsonl("s2", ts2.toISOString()));
    await utimes(f2, ts2, ts2);

    const f3 = join(bucket2, "s3.jsonl");
    await writeFile(f3, makeSessionJsonl("s3", ts2.toISOString()));
    await utimes(f3, ts2, ts2);

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
    await rm(sessionsRoot, { recursive: true, force: true });
    await rm(projectDir1, { recursive: true, force: true });
    await rm(projectDir2, { recursive: true, force: true });
  });

  it("returns discovered projects sorted by recency", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects.length).toBe(2);
    expect(data.projects[0].sessionCount).toBeGreaterThan(0);
    expect(data.projects[0].displayPath).toBeDefined();
  });

  it("returns projects sorted by lastActivityAt descending", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    const data = await res.json();
    expect(data.projects[0].cwd).toBe(projectDir2);
    expect(data.projects[1].cwd).toBe(projectDir1);
  });
});

describe("POST /api/sessions with cwd validation", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let cwdDir: string;

  beforeAll(async () => {
    cwdDir = await mkdtemp(join(tmpdir(), "pi-web-cwd-"));
    sessionsRoot = await mkdtemp(join(tmpdir(), "pi-web-sessions-"));

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
    await rm(sessionsRoot, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  });

  it("returns 400 when cwd is missing", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("cwd");
  });

  it("returns 400 when cwd is not a valid directory", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/nonexistent/path/xyz" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid directory");
  });

  it("returns 400 when body is not JSON", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions returns cwd per session", () => {
  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let cwdDir: string;
  let bucketDir: string;

  beforeAll(async () => {
    cwdDir = await mkdtemp(join(tmpdir(), "pi-web-cwd-"));
    sessionsRoot = await mkdtemp(join(tmpdir(), "pi-web-sessions-"));
    bucketDir = join(sessionsRoot, encodeCwd(cwdDir));
    await mkdir(bucketDir, { recursive: true });

    const ts = new Date().toISOString();
    await writeFile(
      join(bucketDir, "sess.jsonl"),
      JSON.stringify({ type: "session", version: 3, id: "test-sess-cwd-id", timestamp: ts, cwd: cwdDir }) + "\n",
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
    await rm(sessionsRoot, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  });

  it("each session includes cwdRaw field", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    const data = await res.json();
    expect(data.sessions.length).toBe(1);
    const s = data.sessions[0];
    expect(s.cwdRaw).toBe(cwdDir);
    expect(s.cwd).toBeDefined();
  });
});
