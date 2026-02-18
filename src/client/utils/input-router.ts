import type { SlashCommandSpec } from "@shared/types.js";

export type SubmitIntent = "send" | "steer" | "follow_up";

export type RoutedInput =
  | { kind: "none" }
  | { kind: "local_command"; name: string; text: string }
  | { kind: "bash"; command: string; includeInContext: boolean }
  | { kind: "prompt"; text: string }
  | { kind: "steer"; text: string }
  | { kind: "follow_up"; text: string };

export interface RouteInputOptions {
  intent: SubmitIntent;
  isStreaming: boolean;
  commands?: SlashCommandSpec[];
  localCommandNames?: Iterable<string>;
}

export function routeInputText(
  rawText: string,
  options: RouteInputOptions,
): RoutedInput {
  const text = rawText.trim();
  if (!text) return { kind: "none" };

  const bangBang = parseBangCommand(text, "!!");
  if (bangBang) {
    return { kind: "bash", command: bangBang, includeInContext: false };
  }

  const bang = parseBangCommand(text, "!");
  if (bang) {
    return { kind: "bash", command: bang, includeInContext: true };
  }

  const slashName = parseSlashCommandName(text);
  if (slashName && isLocalCommand(slashName, options.localCommandNames)) {
    return { kind: "local_command", name: slashName, text };
  }

  if (options.intent === "follow_up") {
    return { kind: "follow_up", text };
  }

  if (options.intent === "steer") {
    if (
      options.isStreaming &&
      slashName &&
      isExtensionSlashCommand(slashName, options.commands)
    ) {
      // Extension commands must be sent via prompt even while streaming.
      return { kind: "prompt", text };
    }
    return options.isStreaming
      ? { kind: "steer", text }
      : { kind: "prompt", text };
  }

  return { kind: "prompt", text };
}

export function parseSlashCommandName(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const token = text.slice(1).split(/\s+/, 1)[0]?.trim();
  return token ? token : null;
}

function parseBangCommand(text: string, prefix: "!" | "!!"): string | null {
  if (!text.startsWith(prefix)) return null;
  if (prefix === "!" && text.startsWith("!!")) return null;

  const command = text.slice(prefix.length).trim();
  return command.length > 0 ? command : null;
}

function isLocalCommand(name: string, localCommandNames?: Iterable<string>): boolean {
  if (!localCommandNames) return false;
  for (const local of localCommandNames) {
    if (local === name) return true;
  }
  return false;
}

function isExtensionSlashCommand(
  name: string,
  commands?: SlashCommandSpec[],
): boolean {
  if (!commands?.length) return false;
  return commands.some((cmd) => cmd.source === "extension" && cmd.name === name);
}
