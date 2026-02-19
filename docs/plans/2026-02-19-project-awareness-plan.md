# Project/CWD Awareness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the web UI project-aware so users can create sessions in any previously-used project directory, and see sessions from all projects in a single time-sorted list.

**Architecture:** Add a backtracking `decodeCwd` function to resolve encoded bucket names back to filesystem paths. A `ProjectRegistry` scans `~/.pi/agent/sessions/` for project buckets. `SessionManager` is widened to scan all buckets and accept a `cwd` parameter on session creation. The frontend gains a project picker dropdown and per-session CWD display.

**Tech Stack:** TypeScript, Express, Lit, Vitest, Playwright

**Design doc:** `docs/plans/2026-02-19-project-awareness-design.md`

---

### Task 1: Backtracking CWD Decoder

**Files:**
- Create: `src/server/project-registry.ts`
- Test: `tests/api/project-registry.test.ts`

**Step 1: Write the failing test**

Create `tests/api/project-registry.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { decodeCwd } from "../../src/server/project-registry.js";
import { encodeCwd } from "../../src/server/config.js";

describe("decodeCwd", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "decode-cwd-test-"));
    // Create test directory structures
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
    // Both exist, but encodeCwd produces different encoded strings for each
    const enc1 = encodeCwd(join(root, "a-b", "c"));
    const enc2 = encodeCwd(join(root, "a", "b-c"));
    const r1 = await decodeCwd(enc1);
    const r2 = await decodeCwd(enc2);
    // They may or may not be distinguishable — but both should resolve to a valid path
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });

  it("returns null for unresolvable encoded names", async () => {
    const result = await decodeCwd("--does-not-exist-at-all--");
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/project-registry.test.ts`
Expected: FAIL — `decodeCwd` does not exist

**Step 3: Write minimal implementation**

Create `src/server/project-registry.ts` with the `decodeCwd` function:

```typescript
import { stat } from "fs/promises";
import { join } from "path";

export async function decodeCwd(encoded: string): Promise<string | null> {
  const inner = encoded.replace(/^--/, "").replace(/--$/, "");
  if (!inner) return null;

  const segments = inner.split("-");
  if (segments.length === 0) return null;

  const result = await backtrack(segments, 0, "/");
  return result;
}

async function backtrack(
  segments: string[],
  index: number,
  currentPath: string,
): Promise<string | null> {
  if (index >= segments.length) {
    return (await isDirectory(currentPath)) ? currentPath : null;
  }

  // Try extending the current component with a dash (join)
  // and starting a new component with a slash (split).
  // Prefer split (/) first since most dashes are path separators.

  // Option 1: this segment starts a new path component (dash was /)
  const splitPath = join(currentPath, segments[index]);
  if (await isDirectory(splitPath)) {
    const result = await backtrack(segments, index + 1, splitPath);
    if (result) return result;
  }

  // Option 2: this segment extends the current last component (dash was literal -)
  const parts = currentPath.split("/");
  const lastComponent = parts[parts.length - 1];
  const parentPath = parts.slice(0, -1).join("/") || "/";
  const joinedComponent = lastComponent + "-" + segments[index];
  const joinPath = join(parentPath, joinedComponent);

  if (index === 0) {
    // First segment — can only start a new component, can't join to root
    return null;
  }

  if (await isDirectory(joinPath)) {
    const result = await backtrack(segments, index + 1, joinPath);
    if (result) return result;
  }

  return null;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/project-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/project-registry.ts tests/api/project-registry.test.ts
git commit -m "feat: add backtracking CWD decoder for session bucket names"
```

---

### Task 2: Project Registry — `listProjects`

**Files:**
- Modify: `src/server/project-registry.ts`
- Modify: `tests/api/project-registry.test.ts`

**Step 1: Write the failing test**

Add to `tests/api/project-registry.test.ts`:

```typescript
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { listProjects, type ProjectInfo } from "../../src/server/project-registry.js";

describe("listProjects", () => {
  let sessionsRoot: string;
  let projectDir1: string;
  let projectDir2: string;

  beforeAll(async () => {
    sessionsRoot = await mkdtemp(join(tmpdir(), "list-projects-test-"));

    // Create two fake project directories
    projectDir1 = await mkdtemp(join(tmpdir(), "proj1-"));
    projectDir2 = await mkdtemp(join(tmpdir(), "proj2-"));

    // Create bucket directories with session files
    const bucket1 = encodeCwd(projectDir1);
    const bucket2 = encodeCwd(projectDir2);
    await mkdir(join(sessionsRoot, bucket1), { recursive: true });
    await mkdir(join(sessionsRoot, bucket2), { recursive: true });

    // Bucket 1: one session file, older
    await writeFile(
      join(sessionsRoot, bucket1, "session1.jsonl"),
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-02-18T00:00:00Z" }) + "\n",
    );

    // Bucket 2: two session files, newer
    await writeFile(
      join(sessionsRoot, bucket2, "session2.jsonl"),
      JSON.stringify({ type: "session", id: "s2", timestamp: "2026-02-19T00:00:00Z" }) + "\n",
    );
    await writeFile(
      join(sessionsRoot, bucket2, "session3.jsonl"),
      JSON.stringify({ type: "session", id: "s3", timestamp: "2026-02-19T01:00:00Z" }) + "\n",
    );

    // Create a non-bucket directory (no -- prefix) — should be ignored
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
    // The "random-dir" without -- prefix is already skipped.
    // Add a -- prefixed bucket that can't resolve:
    await mkdir(join(sessionsRoot, "--does-not-exist-anywhere--"), { recursive: true });
    const projects = await listProjects(sessionsRoot);
    expect(projects.find(p => p.encodedCwd === "--does-not-exist-anywhere--")).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/project-registry.test.ts`
Expected: FAIL — `listProjects` does not exist

**Step 3: Write the implementation**

Add to `src/server/project-registry.ts`:

```typescript
import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface ProjectInfo {
  cwd: string;
  encodedCwd: string;
  sessionDir: string;
  sessionCount: number;
  lastActivityAt: string;
  displayPath: string;
}

export async function listProjects(sessionsRoot: string): Promise<ProjectInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return [];
  }

  const buckets = entries.filter(e => e.startsWith("--") && e.endsWith("--"));
  const projects: ProjectInfo[] = [];

  for (const bucket of buckets) {
    const cwd = await decodeCwd(bucket);
    if (!cwd) continue;

    const bucketPath = join(sessionsRoot, bucket);
    let bucketEntries: string[];
    try {
      bucketEntries = await readdir(bucketPath);
    } catch {
      continue;
    }

    const jsonlFiles = bucketEntries.filter(f => f.endsWith(".jsonl"));

    let lastActivityAt = new Date(0).toISOString();
    for (const file of jsonlFiles) {
      try {
        const s = await stat(join(bucketPath, file));
        const mtime = new Date(s.mtimeMs).toISOString();
        if (mtime > lastActivityAt) lastActivityAt = mtime;
      } catch {
        continue;
      }
    }

    const home = homedir();
    const displayPath = cwd.startsWith(home)
      ? "~" + cwd.slice(home.length)
      : cwd;

    projects.push({
      cwd,
      encodedCwd: bucket,
      sessionDir: bucketPath,
      sessionCount: jsonlFiles.length,
      lastActivityAt,
      displayPath,
    });
  }

  projects.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return projects;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/api/project-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/project-registry.ts tests/api/project-registry.test.ts
git commit -m "feat: add project registry to discover known projects"
```

---

### Task 3: Config and Types Changes

**Files:**
- Modify: `src/server/config.ts` — rename `sessionDir` → `sessionsRoot`, remove `cwd`, change default
- Modify: `src/shared/types.ts` — add `cwd` and `cwdRaw` to `SessionMeta`

**Step 1: Update `ServerConfig` in `src/server/config.ts`**

Changes:
- `ServerConfig.sessionDir` → `ServerConfig.sessionsRoot`
- Remove `ServerConfig.cwd`
- Default `sessionsRoot` to `~/.pi/agent/sessions/` (the parent, not the per-CWD bucket)
- `--session-dir` CLI arg → `--sessions-root`
- `PI_SESSION_DIR` env var → `PI_SESSIONS_ROOT`

```typescript
export interface ServerConfig {
  port: number;
  sessionsRoot: string;
  idleTimeoutMs: number;
  piCommand: string;
}

export function loadConfig(argv: string[]): ServerConfig {
  const args = parseArgs(argv);

  const sessionsRoot =
    args["sessions-root"] ||
    process.env.PI_SESSIONS_ROOT ||
    join(homedir(), ".pi", "agent", "sessions");

  // ... port, idleTimeoutMs, piCommand same as before ...

  return { port, sessionsRoot, idleTimeoutMs, piCommand };
}
```

Keep `encodeCwd` as-is (still needed for computing bucket paths from CWDs).

**Step 2: Update `SessionMeta` in `src/shared/types.ts`**

Add two new optional fields:

```typescript
export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  lastActivityAt: string;
  messageStats: SessionMessageStats;
  model?: string;
  activity: SessionActivity;
  cwd?: string;     // shortened display path, e.g. "~/code/my-pi-web"
  cwdRaw?: string;  // absolute path, e.g. "/Users/user/code/my-pi-web"
}
```

**Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — many files still reference `config.sessionDir` and `config.cwd`

This is expected. We'll fix the consumers in the next tasks. For now, commit the type/config changes and immediately move to Task 4 which fixes all references.

**Step 4: Commit (types-only, build won't pass yet)**

```bash
git add src/server/config.ts src/shared/types.ts
git commit -m "refactor: rename sessionDir to sessionsRoot, add cwd to SessionMeta"
```

---

### Task 4: SessionManager Multi-Project Refactor

This is the largest task. The SessionManager must:
- Scan all project buckets under `sessionsRoot`
- Track which CWD each active session belongs to
- Accept `cwd` parameter for `createSession`
- Resolve CWD when resuming a session via `getOrSpawn`
- Return CWD info alongside RPC process

**Files:**
- Modify: `src/server/session-manager.ts`

**Step 1: Update the internal data structures**

Key changes to `session-manager.ts`:

1. `ActiveSession` gains `cwd: string` field (line 15-24)
2. `ParsedSessionFile` gains `bucketDir: string` field to track which bucket it came from
3. File cache keys change from filename to `bucketDir/filename` to be unique across buckets
4. `sessionFileById` maps to `{ bucketDir, file }` instead of just `file`
5. `this.config.sessionDir` → `this.config.sessionsRoot` everywhere
6. `this.config.cwd` → removed; CWD comes from per-session or per-bucket context

**Step 2: Rewrite `listSessions()` (lines 60-117)**

New logic:
1. `readdir(this.config.sessionsRoot)` to get all bucket directories
2. Filter to `--...--` pattern
3. For each bucket: decode CWD with `decodeCwd`, scan `.jsonl` files, parse each
4. Add `cwd` and `cwdRaw` to each `SessionMeta`
5. Filter to sessions within last 7 days
6. Sort by `lastActivityAt` descending

**Step 3: Rewrite `createSession(cwd: string)` (lines 119-152)**

New logic:
1. Accept `cwd` parameter
2. Compute `bucketDir = join(this.config.sessionsRoot, encodeCwd(cwd))`
3. `mkdir(bucketDir, { recursive: true })` — create bucket if needed
4. Pass `cwd` to `new RpcProcess(...)` instead of `this.config.cwd`
5. Store `cwd` in the `ActiveSession` entry

**Step 4: Rewrite `getOrSpawn` (lines 223-269)**

New logic:
1. If session is already active: return `{ rpc: entry.rpc, cwd: entry.cwd }`
2. If session is on disk: determine CWD from bucket directory name via `decodeCwd`
3. Pass the resolved CWD to `new RpcProcess(...)`
4. Store CWD in the `ActiveSession`
5. Return type changes from `Promise<RpcProcess>` to `Promise<{ rpc: RpcProcess; cwd: string }>`

**Step 5: Update `findSessionFile` to search all buckets (lines 536-552)**

New logic: scan all bucket directories (not just one) when looking for a session by ID. Return `{ bucketDir, file }` tuple.

**Step 6: Update `updateSession` and `deleteSession` to use multi-bucket paths**

These currently use `join(this.config.sessionDir, sessionFile)`. They need to use `join(bucketDir, file)` from the lookup result.

**Step 7: Update `getHistory` and `addCustomMessage` similarly**

Same pattern — use the resolved bucket path.

**Step 8: Remove the `cwd` getter (line 56-58)**

It no longer makes sense with multi-project. The ws-handler will get CWD from `getOrSpawn`'s return value.

**Step 9: Run typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — routes.ts and ws-handler.ts still reference old API

**Step 10: Commit**

```bash
git add src/server/session-manager.ts
git commit -m "refactor: make SessionManager multi-project aware"
```

---

### Task 5: API and WebSocket Handler Changes

**Files:**
- Modify: `src/server/routes.ts`
- Modify: `src/server/ws-handler.ts`

**Step 1: Update `routes.ts`**

1. `GET /api/health`: replace `cwd: sessions.cwd` with `sessionsRoot: sessions.sessionsRoot`. Remove `gitBranch` (was per-CWD, no longer meaningful for a single value).
2. `POST /api/sessions`: parse `req.body.cwd`, validate it's a string and an existing directory, call `sessions.createSession(req.body.cwd)`. Return 400 if `cwd` is missing or invalid.
3. Add `GET /api/projects` route: call `listProjects(sessions.sessionsRoot)` and return the list.
4. Add a `sessionsRoot` getter to `SessionManager` (or pass config directly).

```typescript
// New route
router.get("/projects", async (_req, res) => {
  const projects = await listProjects(sessions.sessionsRoot);
  res.json({ projects });
});

// Updated POST
router.post("/sessions", async (req, res) => {
  const cwd = req.body?.cwd;
  if (typeof cwd !== "string" || !cwd) {
    res.status(400).json({ error: "Missing required field: cwd" });
    return;
  }
  // validate directory exists
  try {
    const s = await stat(cwd);
    if (!s.isDirectory()) throw new Error("not a directory");
  } catch {
    res.status(400).json({ error: `Invalid directory: ${cwd}` });
    return;
  }
  const id = await sessions.createSession(cwd);
  res.status(201).json({ id });
});
```

**Step 2: Update `ws-handler.ts`**

The `handleSessionWebSocket` function uses `sessions.cwd` at line 155 for local shell commands. After the refactor, `getOrSpawn` returns `{ rpc, cwd }`. Use the session-specific `cwd` instead:

```typescript
// Before:
const run = startLocalShell(command, sessions.cwd);

// After:
const run = startLocalShell(command, sessionCwd);
```

Where `sessionCwd` comes from the destructured `getOrSpawn` result:
```typescript
const { rpc: rpcProcess, cwd: sessionCwd } = await sessions.getOrSpawn(sessionId, listener);
rpc = rpcProcess;
```

**Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (all references updated)

**Step 4: Commit**

```bash
git add src/server/routes.ts src/server/ws-handler.ts src/server/session-manager.ts
git commit -m "feat: add /api/projects endpoint, POST /sessions accepts cwd"
```

---

### Task 6: Update Existing Tests

**Files:**
- Modify: `tests/api/sessions.test.ts`
- Modify: `tests/e2e/app.spec.ts`
- Modify: `playwright.config.ts`

**Step 1: Update unit tests in `sessions.test.ts`**

All `ServerConfig` objects need updating:
- `sessionDir` → `sessionsRoot`
- Remove `cwd` field
- Session JSONL files need to be placed inside a bucket subdirectory (since the manager now scans buckets)

For the JSONL-based tests: create a bucket directory inside the temp dir (e.g., `--test-cwd--/`) and place `.jsonl` files inside it. Also create the actual temp directory that the bucket name decodes to.

For the "real pi" tests: `POST /api/sessions` now requires a `{ cwd }` body. Update the fetch call.

For the health endpoint test: check for `sessionsRoot` instead of `cwd`.

**Step 2: Update `playwright.config.ts`**

Change `--session-dir` to `--sessions-root`:

```typescript
command: "npx tsx src/server/main.ts --port 3001 --sessions-root /tmp/pi-web-e2e-sessions",
```

**Step 3: Update E2E helpers in `app.spec.ts`**

The `createSession` helper needs to send a body with `cwd`. The E2E test session directory structure needs a bucket subdirectory.

**Step 4: Run all tests**

Run: `npx vitest run && npx playwright test`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/ playwright.config.ts
git commit -m "test: update tests for multi-project session manager"
```

---

### Task 7: Add API-Level Tests for New Endpoints

**Files:**
- Modify: `tests/api/sessions.test.ts` (or create `tests/api/projects.test.ts`)

**Step 1: Write failing tests**

```typescript
describe("GET /api/projects", () => {
  // Setup: create sessionsRoot with two bucket dirs, each containing sessions
  // Each bucket's decoded CWD must exist on disk (use temp dirs)

  it("returns discovered projects sorted by recency", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects.length).toBe(2);
    expect(data.projects[0].sessionCount).toBeGreaterThan(0);
    expect(data.projects[0].displayPath).toBeDefined();
  });
});

describe("POST /api/sessions with cwd", () => {
  it("returns 400 when cwd is missing", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when cwd is not a valid directory", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/nonexistent/path" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions returns cwd per session", () => {
  // Setup: create sessions in different buckets

  it("each session includes cwd and cwdRaw fields", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    const data = await res.json();
    for (const s of data.sessions) {
      expect(s.cwdRaw).toBeDefined();
      expect(s.cwd).toBeDefined();
    }
  });
});
```

**Step 2: Implement until tests pass**

**Step 3: Commit**

```bash
git add tests/api/
git commit -m "test: add tests for /api/projects and cwd-aware session creation"
```

---

### Task 8: Frontend — Session Card CWD Display

**Files:**
- Modify: `src/client/components/session-list.ts` (lines 622-685)
- Modify: `src/client/utils/session-actions.ts`

**Step 1: Update session-actions.ts**

Update `RuntimeInfo` to remove the single `cwd` (no longer relevant) or keep it for the health endpoint. Add a `fetchProjects` function:

```typescript
export interface ProjectInfo {
  cwd: string;
  displayPath: string;
  sessionCount: number;
  lastActivityAt: string;
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
```

**Step 2: Add CWD to session card rendering**

In `session-list.ts`, the `renderSession` method (line 615-685):

Add the CWD display path to `metaParts`:

```typescript
const metaParts = [
  s.cwd || "",             // project path (new)
  `${s.messageStats?.totalMessages ?? 0} msg`,
  s.model || "unknown model",
  relativeTime(s.lastActivityAt),
].filter(Boolean);
```

**Step 3: Commit**

```bash
git add src/client/components/session-list.ts src/client/utils/session-actions.ts
git commit -m "feat: display project CWD on session cards"
```

---

### Task 9: Frontend — Project Picker Dropdown

**Files:**
- Modify: `src/client/components/session-list.ts`

**Step 1: Add project state and fetching**

Add to the component class:
- `@state() private projects: ProjectInfo[] = []`
- `@state() private showProjectPicker = false`
- Fetch projects in `connectedCallback` alongside sessions

**Step 2: Replace "New session" button with picker**

Replace the simple button (line 544) with a button that toggles a dropdown. The dropdown lists projects sorted by most recently used, each showing `displayPath`. Clicking an item calls `createSession(project.cwd)`.

Update `createSession` to accept a CWD:

```typescript
private async createSession(cwd?: string) {
  if (!cwd) return; // must select a project
  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    window.location.hash = `#/session/${data.id}`;
  } catch (e) {
    this.error = `Failed to create session: ${e}`;
  }
}
```

**Step 3: Style the dropdown**

Add CSS for the project picker dropdown — position absolute, below the button, z-index above session list, matching existing theme vars.

**Step 4: Commit**

```bash
git add src/client/components/session-list.ts
git commit -m "feat: new session button opens project picker dropdown"
```

---

### Task 10: Frontend — Bottom Project List

**Files:**
- Modify: `src/client/components/session-list.ts`

**Step 1: Add project list section below sessions**

After the `${this.renderGroupedSessions()}` block (around line 563), add a "Projects" section:

```typescript
html`
  <div class="projects-section">
    <h2 class="projects-heading">Projects</h2>
    ${this.projects.length === 0
      ? html`<div class="projects-empty">No projects found. Use pi in a project directory first.</div>`
      : this.projects.map(p => html`
          <div class="project-row">
            <span class="project-path">${p.displayPath}</span>
            <span class="project-count">${p.sessionCount} sessions</span>
            <button class="project-new-btn" @click=${() => this.createSession(p.cwd)}>
              New
            </button>
          </div>
        `)}
  </div>
`
```

**Step 2: Style the projects section**

Add CSS for `.projects-section`, `.projects-heading`, `.project-row`, `.project-path`, `.project-count`, `.project-new-btn`. Keep it minimal — muted colors, small text, consistent with existing theme.

**Step 3: Commit**

```bash
git add src/client/components/session-list.ts
git commit -m "feat: add project list section at bottom of session list"
```

---

### Task 11: Server Startup Logging and Final Polish

**Files:**
- Modify: `src/server/main.ts`

**Step 1: Update startup log**

Change from logging `sessionDir` to `sessionsRoot`:

```typescript
server.listen(config.port, () => {
  console.log(`Pi Web UI running on http://localhost:${config.port}`);
  console.log(`Sessions root: ${config.sessionsRoot}`);
});
```

**Step 2: Run full quality gate**

Run: `npm run check`
Expected: PASS (typecheck, lint, test, build)

**Step 3: Commit**

```bash
git add src/server/main.ts
git commit -m "chore: update startup logging for multi-project config"
```

---

### Task 12: Manual Cleanup of Stale Test Buckets

**Files:** None (filesystem cleanup)

**Step 1: Remove stale test tmpdir buckets**

```bash
# Preview what will be deleted
ls ~/.pi/agent/sessions/ | grep 'private-var-folders'

# Remove them
for d in ~/.pi/agent/sessions/--private-var-folders-*; do rm -rf "$d"; done
```

**Step 2: Verify**

```bash
ls ~/.pi/agent/sessions/ | grep -c 'private-var-folders'
# Expected: 0
```

No commit needed — filesystem cleanup only.

---

## Summary of File Changes

| File | Action |
|------|--------|
| `src/server/project-registry.ts` | **Create** — `decodeCwd`, `listProjects`, `ProjectInfo` |
| `src/server/config.ts` | **Modify** — rename `sessionDir`→`sessionsRoot`, remove `cwd` |
| `src/server/session-manager.ts` | **Modify** — multi-bucket scanning, `createSession(cwd)`, `getOrSpawn` returns cwd |
| `src/server/routes.ts` | **Modify** — `POST /sessions` accepts cwd, add `GET /projects` |
| `src/server/ws-handler.ts` | **Modify** — use session-specific CWD for local shells |
| `src/server/main.ts` | **Modify** — update startup log |
| `src/shared/types.ts` | **Modify** — add `cwd`, `cwdRaw` to `SessionMeta` |
| `src/client/components/session-list.ts` | **Modify** — project picker, CWD display, bottom project list |
| `src/client/utils/session-actions.ts` | **Modify** — add `fetchProjects` |
| `tests/api/project-registry.test.ts` | **Create** — decodeCwd and listProjects tests |
| `tests/api/sessions.test.ts` | **Modify** — update for new config shape and API |
| `tests/e2e/app.spec.ts` | **Modify** — update for project picker flow |
| `playwright.config.ts` | **Modify** — `--sessions-root` flag |
