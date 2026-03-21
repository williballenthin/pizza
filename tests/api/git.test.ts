import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp, type AppInstance } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/server/config.js";
import { encodeCwd } from "../../src/server/config.js";
import { mkdtemp, rm, writeFile, mkdir, appendFile } from "fs/promises";
import { execFileSync, execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";

function hasGit(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeSessionJsonl(id: string, cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd,
  }) + "\n";
}

describe("Git API endpoints", () => {
  if (!hasGit()) {
    it.skip("git not installed", () => {});
    return;
  }

  let app: AppInstance;
  let baseUrl: string;
  let sessionsRoot: string;
  let repoDir: string;
  let nonRepoDir: string;
  const repoSessionId = "11111111-2222-3333-4444-555555555555";
  const nonRepoSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeAll(async () => {
    sessionsRoot = await mkdtemp(join(tmpdir(), "pi-web-git-api-"));
    repoDir = await mkdtemp(join(tmpdir(), "pi-web-git-repo-"));
    nonRepoDir = await mkdtemp(join(tmpdir(), "pi-web-git-nonrepo-"));

    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);

    await writeFile(join(repoDir, "tracked.txt"), "base\n");
    await writeFile(join(repoDir, "second.txt"), "second\n");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "initial commit"]);

    await writeFile(join(repoDir, "third.txt"), "third\n");
    runGit(repoDir, ["add", "third.txt"]);
    runGit(repoDir, ["commit", "-m", "add third"]);

    await appendFile(join(repoDir, "tracked.txt"), "staged change\n");
    runGit(repoDir, ["add", "tracked.txt"]);

    await appendFile(join(repoDir, "second.txt"), "unstaged change\n");
    await writeFile(join(repoDir, "untracked.txt"), "untracked\n");

    const repoBucket = join(sessionsRoot, encodeCwd(repoDir));
    await mkdir(repoBucket, { recursive: true });
    await writeFile(
      join(repoBucket, `session_${repoSessionId}.jsonl`),
      makeSessionJsonl(repoSessionId, repoDir),
    );

    const nonRepoBucket = join(sessionsRoot, encodeCwd(nonRepoDir));
    await mkdir(nonRepoBucket, { recursive: true });
    await writeFile(
      join(nonRepoBucket, `session_${nonRepoSessionId}.jsonl`),
      makeSessionJsonl(nonRepoSessionId, nonRepoDir),
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
    await rm(repoDir, { recursive: true, force: true });
    await rm(nonRepoDir, { recursive: true, force: true });
  });

  it("returns staged and unstaged files", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${repoSessionId}/git/status`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.isRepo).toBe(true);
    expect(typeof data.branch).toBe("string");
    expect(data.branch.length).toBeGreaterThan(0);

    expect(
      data.staged.some((change: { path: string; status: string }) =>
        change.path === "tracked.txt" && change.status === "M"
      ),
    ).toBe(true);

    expect(
      data.unstaged.some((change: { path: string; status: string }) =>
        change.path === "second.txt" && change.status === "M"
      ),
    ).toBe(true);

    expect(
      data.unstaged.some((change: { path: string; status: string }) =>
        change.path === "untracked.txt" && change.status === "?"
      ),
    ).toBe(true);
  });

  it("returns recent commits", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${repoSessionId}/git/commits?limit=16`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(Array.isArray(data.commits)).toBe(true);
    expect(data.commits.length).toBeGreaterThanOrEqual(2);
    expect(typeof data.commits[0].hash).toBe("string");
    expect(typeof data.commits[0].shortHash).toBe("string");
  });

  it("returns changed files for a commit", async () => {
    const commitsRes = await fetch(`${baseUrl}/api/sessions/${repoSessionId}/git/commits?limit=1`);
    const commitsData = await commitsRes.json();
    const commit = commitsData.commits[0];

    const filesRes = await fetch(
      `${baseUrl}/api/sessions/${repoSessionId}/git/commits/${commit.hash}/files`,
    );
    expect(filesRes.status).toBe(200);
    const filesData = await filesRes.json();

    expect(Array.isArray(filesData.files)).toBe(true);
    expect(filesData.files.length).toBeGreaterThan(0);
  });

  it("returns staged and unstaged diffs for a file", async () => {
    const stagedRes = await fetch(
      `${baseUrl}/api/sessions/${repoSessionId}/git/diff?scope=staged&path=${encodeURIComponent("tracked.txt")}`,
    );
    expect(stagedRes.status).toBe(200);
    const stagedData = await stagedRes.json();
    expect(stagedData.diff).toContain("staged change");

    const unstagedRes = await fetch(
      `${baseUrl}/api/sessions/${repoSessionId}/git/diff?scope=unstaged&path=${encodeURIComponent("second.txt")}`,
    );
    expect(unstagedRes.status).toBe(200);
    const unstagedData = await unstagedRes.json();
    expect(unstagedData.diff).toContain("unstaged change");
  });

  it("returns commit diff for a file", async () => {
    const commitsRes = await fetch(`${baseUrl}/api/sessions/${repoSessionId}/git/commits?limit=1`);
    const commitsData = await commitsRes.json();
    const commit = commitsData.commits[0];

    const diffRes = await fetch(
      `${baseUrl}/api/sessions/${repoSessionId}/git/diff?scope=commit&sha=${commit.hash}&path=${encodeURIComponent("third.txt")}`,
    );
    expect(diffRes.status).toBe(200);
    const diffData = await diffRes.json();
    expect(typeof diffData.diff).toBe("string");
    expect(diffData.diff).toContain("third");
  });

  it("reports non-repo directories", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${nonRepoSessionId}/git/status`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.isRepo).toBe(false);
    expect(data.staged).toEqual([]);
    expect(data.unstaged).toEqual([]);
  });
});
