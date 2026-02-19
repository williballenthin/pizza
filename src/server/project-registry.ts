import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const decodeCache = new Map<string, string | null>();

export async function decodeCwd(encoded: string): Promise<string | null> {
  if (decodeCache.has(encoded)) return decodeCache.get(encoded)!;

  const inner = encoded.replace(/^--/, "").replace(/--$/, "");
  if (!inner) {
    decodeCache.set(encoded, null);
    return null;
  }

  const segments = inner.split("-");
  if (segments.length === 0) {
    decodeCache.set(encoded, null);
    return null;
  }

  const result = await backtrack(segments, 1, "/", segments[0]);
  decodeCache.set(encoded, result);
  return result;
}

async function backtrack(
  segments: string[],
  index: number,
  parentPath: string,
  currentComponent: string,
): Promise<string | null> {
  if (index >= segments.length) {
    const full = join(parentPath, currentComponent);
    return (await isDirectory(full)) ? full : null;
  }

  const extended = currentComponent + "-" + segments[index];
  const joinResult = await backtrack(segments, index + 1, parentPath, extended);
  if (joinResult) return joinResult;

  const full = join(parentPath, currentComponent);
  if (await isDirectory(full)) {
    const splitResult = await backtrack(segments, index + 1, full, segments[index]);
    if (splitResult) return splitResult;
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
