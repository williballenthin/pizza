import type { SessionActivityUpdate } from "@shared/types.js";

type SessionActivityListener = (update: SessionActivityUpdate) => void;

let source: EventSource | null = null;
const listeners = new Set<SessionActivityListener>();

function ensureSource(): void {
  if (source || listeners.size === 0) return;

  source = new EventSource("/api/sessions/events");

  source.onmessage = (event) => {
    try {
      const update = JSON.parse(event.data) as SessionActivityUpdate;
      for (const listener of listeners) {
        listener(update);
      }
    } catch {
      // Ignore malformed SSE payloads.
    }
  };

  source.onerror = () => {
    // EventSource reconnects automatically.
  };
}

function maybeCloseSource(): void {
  if (source && listeners.size === 0) {
    source.close();
    source = null;
  }
}

export function subscribeSessionActivity(
  listener: SessionActivityListener,
): () => void {
  listeners.add(listener);
  ensureSource();

  return () => {
    listeners.delete(listener);
    maybeCloseSource();
  };
}
