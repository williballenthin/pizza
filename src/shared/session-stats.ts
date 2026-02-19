import type { SessionMessageStats } from "./types.js";

export interface JsonlMessageEntry {
  role: string;
  content?: string | Array<{ type: string; [key: string]: unknown }>;
}

export function emptyMessageStats(): SessionMessageStats {
  return { userMessages: 0, assistantMessages: 0, toolCalls: 0, totalMessages: 0 };
}

export function countMessageStats(entries: JsonlMessageEntry[]): SessionMessageStats {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;

  for (const entry of entries) {
    if (entry.role === "user") {
      userMessages++;
    } else if (entry.role === "assistant") {
      assistantMessages++;
      if (Array.isArray(entry.content)) {
        for (const block of entry.content) {
          if (block.type === "tool_use" || block.type === "toolCall") {
            toolCalls++;
          }
        }
      }
    }
  }

  return { userMessages, assistantMessages, toolCalls, totalMessages: entries.length };
}
