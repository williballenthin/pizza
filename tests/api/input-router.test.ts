import { describe, it, expect } from "vitest";
import {
  routeInputText,
  parseSlashCommandName,
} from "../../src/client/utils/input-router.js";

describe("input-router", () => {
  it("routes !command to bash with context", () => {
    const routed = routeInputText("!echo hello", {
      intent: "send",
      isStreaming: false,
    });

    expect(routed).toEqual({
      kind: "bash",
      command: "echo hello",
      includeInContext: true,
    });
  });

  it("routes !!command to bash without context", () => {
    const routed = routeInputText("!!npm test", {
      intent: "send",
      isStreaming: false,
    });

    expect(routed).toEqual({
      kind: "bash",
      command: "npm test",
      includeInContext: false,
    });
  });

  it("routes steering intent to steer while streaming", () => {
    const routed = routeInputText("please continue", {
      intent: "steer",
      isStreaming: true,
    });

    expect(routed).toEqual({ kind: "steer", text: "please continue" });
  });

  it("routes follow_up intent to follow_up", () => {
    const routed = routeInputText("try a different approach", {
      intent: "follow_up",
      isStreaming: true,
    });

    expect(routed).toEqual({
      kind: "follow_up",
      text: "try a different approach",
    });
  });

  it("routes extension slash command to prompt while streaming", () => {
    const routed = routeInputText("/my-ext do thing", {
      intent: "steer",
      isStreaming: true,
      commands: [
        {
          name: "my-ext",
          source: "extension",
          description: "run extension command",
        },
      ],
    });

    expect(routed).toEqual({ kind: "prompt", text: "/my-ext do thing" });
  });

  it("parses slash command names", () => {
    expect(parseSlashCommandName("/abc def")).toBe("abc");
    expect(parseSlashCommandName("/abc")).toBe("abc");
    expect(parseSlashCommandName("not a slash")).toBeNull();
  });
});
