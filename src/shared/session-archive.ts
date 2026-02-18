export const ARCHIVED_SESSION_PREFIX = "archived: ";

export function isArchivedSessionName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.toLowerCase().startsWith(ARCHIVED_SESSION_PREFIX);
}

export function archiveSessionName(name: string): string {
  const clean = unarchiveSessionName(name).trim();
  return `${ARCHIVED_SESSION_PREFIX}${clean || "Session"}`;
}

export function unarchiveSessionName(name: string): string {
  if (!name) return "";
  if (!isArchivedSessionName(name)) return name;
  return name.slice(ARCHIVED_SESSION_PREFIX.length).trimStart();
}
