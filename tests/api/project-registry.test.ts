import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { homedir } from "os";
import { decodeCwd, listProjects, type ProjectInfo } from "../../src/server/project-registry.js";
import { encodeCwd } from "../../src/server/config.js";

describe("decodeCwd", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "decode-cwd-test-"));
    await mkdir(join(root, "Users", "user", "code", "my-pi-web"), { recursive: true });
    await mkdir(join(root, "Users", "user", "code", "my", "pi", "web"), { recursive: true });
    await mkdir(join(root, "a-b", "c"), { recursive: true });
    await mkdir(join(root, "a", "b-c"), { recursive: true });
    await mkdir(join(root, "simple"), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("decodes a simple single-component path", async () => {
    const encoded = encodeCwd(join(root, "simple"));
    const result = await decodeCwd(encoded);
    expect(result).toBe(join(root, "simple"));
  });

  it("decodes a multi-component path without dashes", async () => {
    const encoded = encodeCwd(join(root, "Users", "user", "code"));
    const result = await decodeCwd(encoded);
    expect(result).toBe(join(root, "Users", "user", "code"));
  });

  it("decodes a path where a component contains dashes", async () => {
    const encoded = encodeCwd(join(root, "Users", "user", "code", "my-pi-web"));
    const result = await decodeCwd(encoded);
    expect(result).toBe(join(root, "Users", "user", "code", "my-pi-web"));
  });

  it("disambiguates a-b/c from a/b-c", async () => {
    const enc1 = encodeCwd(join(root, "a-b", "c"));
    const enc2 = encodeCwd(join(root, "a", "b-c"));
    const r1 = await decodeCwd(enc1);
    const r2 = await decodeCwd(enc2);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });

  it("returns null for unresolvable encoded names", async () => {
    const result = await decodeCwd("--does-not-exist-at-all--");
    expect(result).toBeNull();
  });
});

describe("listProjects", () => {
  let sessionsRoot: string;
  let projectDir1: string;
  let projectDir2: string;

  beforeAll(async () => {
    sessionsRoot = await mkdtemp(join(tmpdir(), "list-projects-test-"));

    projectDir1 = await mkdtemp(join(tmpdir(), "proj1-"));
    projectDir2 = await mkdtemp(join(tmpdir(), "proj2-"));

    const bucket1 = encodeCwd(projectDir1);
    const bucket2 = encodeCwd(projectDir2);
    await mkdir(join(sessionsRoot, bucket1), { recursive: true });
    await mkdir(join(sessionsRoot, bucket2), { recursive: true });

    const file1 = join(sessionsRoot, bucket1, "session1.jsonl");
    await writeFile(
      file1,
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-02-18T00:00:00Z" }) + "\n",
    );
    await utimes(file1, new Date("2026-02-18T00:00:00Z"), new Date("2026-02-18T00:00:00Z"));

    const file2 = join(sessionsRoot, bucket2, "session2.jsonl");
    await writeFile(
      file2,
      JSON.stringify({ type: "session", id: "s2", timestamp: "2026-02-19T00:00:00Z" }) + "\n",
    );
    await utimes(file2, new Date("2026-02-19T00:00:00Z"), new Date("2026-02-19T00:00:00Z"));

    const file3 = join(sessionsRoot, bucket2, "session3.jsonl");
    await writeFile(
      file3,
      JSON.stringify({ type: "session", id: "s3", timestamp: "2026-02-19T01:00:00Z" }) + "\n",
    );
    await utimes(file3, new Date("2026-02-19T01:00:00Z"), new Date("2026-02-19T01:00:00Z"));

    await mkdir(join(sessionsRoot, "random-dir"), { recursive: true });
  });

  afterAll(async () => {
    await rm(sessionsRoot, { recursive: true, force: true });
    await rm(projectDir1, { recursive: true, force: true });
    await rm(projectDir2, { recursive: true, force: true });
  });

  it("discovers projects from session bucket directories", async () => {
    const projects = await listProjects(sessionsRoot);
    expect(projects.length).toBe(2);
  });

  it("returns projects sorted by lastActivityAt descending", async () => {
    const projects = await listProjects(sessionsRoot);
    expect(projects[0].cwd).toBe(projectDir2);
    expect(projects[1].cwd).toBe(projectDir1);
  });

  it("includes correct session counts", async () => {
    const projects = await listProjects(sessionsRoot);
    const p1 = projects.find(p => p.cwd === projectDir1)!;
    const p2 = projects.find(p => p.cwd === projectDir2)!;
    expect(p1.sessionCount).toBe(1);
    expect(p2.sessionCount).toBe(2);
  });

  it("computes displayPath with ~ for homedir", async () => {
    const projects = await listProjects(sessionsRoot);
    for (const p of projects) {
      if (p.cwd.startsWith(homedir())) {
        expect(p.displayPath.startsWith("~")).toBe(true);
      }
    }
  });

  it("skips unresolvable bucket directories", async () => {
    await mkdir(join(sessionsRoot, "--does-not-exist-anywhere--"), { recursive: true });
    const projects = await listProjects(sessionsRoot);
    expect(projects.find(p => p.encodedCwd === "--does-not-exist-anywhere--")).toBeUndefined();
  });
});
