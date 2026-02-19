import { describe, it, expect } from "vitest";
import {
  countMessageStats,
  emptyMessageStats,
  type JsonlMessageEntry,
} from "../../src/shared/session-stats.js";

describe("emptyMessageStats", () => {
  it("returns all zeros", () => {
    expect(emptyMessageStats()).toEqual({
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      totalMessages: 0,
    });
  });
});

describe("countMessageStats", () => {
  it("counts user messages", () => {
    const entries: JsonlMessageEntry[] = [
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ];
    const stats = countMessageStats(entries);
    expect(stats.userMessages).toBe(2);
    expect(stats.totalMessages).toBe(2);
  });

  it("counts assistant messages", () => {
    const entries: JsonlMessageEntry[] = [
      { role: "assistant", content: "hi there" },
    ];
    const stats = countMessageStats(entries);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.toolCalls).toBe(0);
  });

  it("counts tool_use blocks in assistant messages as tool calls", () => {
    const entries: JsonlMessageEntry[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", id: "t1", name: "read", input: {} },
          { type: "tool_use", id: "t2", name: "write", input: {} },
        ],
      },
    ];
    const stats = countMessageStats(entries);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.toolCalls).toBe(2);
  });

  it("counts toolCall blocks as tool calls", () => {
    const entries: JsonlMessageEntry[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", input: "ls" }],
      },
    ];
    const stats = countMessageStats(entries);
    expect(stats.toolCalls).toBe(1);
  });

  it("ignores tool_result and other roles", () => {
    const entries: JsonlMessageEntry[] = [
      { role: "tool_result", content: "output" },
      { role: "system", content: "you are helpful" },
    ];
    const stats = countMessageStats(entries);
    expect(stats).toEqual({
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      totalMessages: 2,
    });
  });

  it("handles mixed conversation", () => {
    const entries: JsonlMessageEntry[] = [
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file" },
          { type: "tool_use", id: "t1", name: "read", input: {} },
        ],
      },
      { role: "tool_result", content: "file contents..." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here's the fix" },
          { type: "tool_use", id: "t2", name: "edit", input: {} },
        ],
      },
      { role: "tool_result", content: "ok" },
      { role: "assistant", content: "Done! The bug is fixed." },
      { role: "user", content: "thanks" },
    ];
    const stats = countMessageStats(entries);
    expect(stats.userMessages).toBe(2);
    expect(stats.assistantMessages).toBe(3);
    expect(stats.toolCalls).toBe(2);
    expect(stats.totalMessages).toBe(7);
  });

  it("handles empty array", () => {
    expect(countMessageStats([])).toEqual(emptyMessageStats());
  });
});
