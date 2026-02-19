import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AgentMessageData } from "@shared/types.js";
import {
  escapeHtml,
  formatExpandableOutput,
  formatTimestamp,
  getLanguageFromPath,
  safeMarkedParse,
  shortenPath,
} from "../utils/pi-export-render.js";

interface MessageBlock {
  type?: string;
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  mimeType?: string;
  data?: string;
  callHtml?: string;
  resultHtml?: string;
  rendered?: {
    callHtml?: string;
    resultHtml?: string;
  };
}

interface ToolResultMessage extends AgentMessageData {
  role: "toolResult";
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
  output?: unknown;
  isError?: boolean;
  details?: {
    diff?: string;
    [key: string]: unknown;
  };
  resultHtml?: string;
  rendered?: {
    resultHtml?: string;
  };
}

interface BashExecutionMessage extends AgentMessageData {
  role: "bashExecution";
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
}

@customElement("message-list")
export class MessageList extends LitElement {
  override createRenderRoot() {
    return this;
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("expandToolOutputs")) {
      this.querySelectorAll(".tool-call-details").forEach((node) => {
        const details = node as HTMLDetailsElement;
        details.open = this.expandToolOutputs;
      });

      this.querySelectorAll(".tool-output.expandable").forEach((node) => {
        node.classList.toggle("expanded", this.expandToolOutputs);
      });
    }
  }

  @property({ type: Array }) messages: AgentMessageData[] = [];
  @property({ type: Array }) allMessages: AgentMessageData[] = [];
  @property({ type: Boolean }) isStreaming = false;
  @property({ attribute: false }) pendingToolCalls = new Set<string>();
  @property({ type: Boolean }) showThinking = true;
  @property({ type: Boolean }) expandToolOutputs = false;
  @property({ type: String }) targetPrefix = "msg-";

  render() {
    const sourceMessages = this.allMessages.length > 0 ? this.allMessages : this.messages;
    const toolResults = new Map<string, ToolResultMessage>();
    const toolCalls = new Set<string>();

    for (const message of sourceMessages) {
      if (message.role === "assistant") {
        for (const block of this.asBlocks(message.content)) {
          if (block.type === "toolCall" && block.id) {
            toolCalls.add(block.id);
          }
        }
      }
      if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        toolResults.set(message.toolCallId, message as ToolResultMessage);
      }
    }

    const visible = this.messages.filter((message) => {
      if (message.role === "artifact") return false;
      if (
        message.role === "toolResult" &&
        typeof message.toolCallId === "string" &&
        toolCalls.has(message.toolCallId)
      ) {
        return false;
      }
      return true;
    });

    return html`
      <div class="ml-list">
        ${visible.map((message, index) =>
          this.renderMessage(message, toolResults, index),
        )}
      </div>
    `;
  }

  private renderMessage(
    message: AgentMessageData,
    toolResults: Map<string, ToolResultMessage>,
    renderIndex: number,
  ): TemplateResult | typeof nothing {
    if (message.role === "user" || message.role === "user-with-attachments") {
      return this.renderUserMessage(message, renderIndex);
    }

    if (message.role === "assistant") {
      return this.renderAssistantMessage(message, toolResults, renderIndex);
    }

    if (message.role === "toolResult") {
      return this.renderOrphanToolResult(message as ToolResultMessage, renderIndex);
    }

    if (message.role === "bashExecution") {
      return this.renderBashExecution(message as BashExecutionMessage, renderIndex);
    }

    return nothing;
  }

  private targetId(renderIndex: number): string {
    return `${this.targetPrefix}${renderIndex}`;
  }

  private renderCopyButton(targetId: string): TemplateResult {
    return html`
      <button
        class="copy-link-btn"
        title="Copy link to this message"
        @click=${(e: Event) => {
          e.stopPropagation();
          this.dispatchEvent(
            new CustomEvent("copy-link", {
              detail: { targetId },
              bubbles: true,
              composed: true,
            }),
          );
          const button = e.currentTarget as HTMLButtonElement;
          button.classList.add("copied");
          setTimeout(() => button.classList.remove("copied"), 1400);
        }}
      >
        🔗
      </button>
    `;
  }

  private renderUserMessage(
    message: AgentMessageData,
    renderIndex: number,
  ): TemplateResult {
    const ts = formatTimestamp(message.timestamp);
    const text = this.extractText(message.content).trim();
    const targetId = this.targetId(renderIndex);
    const images = this.asBlocks(message.content).filter(
      (part) =>
        part.type === "image" &&
        typeof part.data === "string" &&
        part.data.length > 0,
    );

    return html`
      <div class="user-message ml-user" id=${targetId}>
        ${this.renderCopyButton(targetId)}
        ${ts ? html`<div class="message-timestamp">${ts}</div>` : nothing}

        ${text
          ? html`<div class="markdown-content">${unsafeHTML(safeMarkedParse(text))}</div>`
          : nothing}

        ${images.length > 0
          ? html`<div class="user-images">
              ${images.map((img) => {
                const mimeType = img.mimeType || "image/png";
                const data = typeof img.data === "string" ? img.data : "";
                if (!data) return nothing;
                return html`<img
                  src=${`data:${mimeType};base64,${data}`}
                  class="user-image"
                  alt="User attachment"
                  loading="lazy"
                />`;
              })}
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderAssistantMessage(
    message: AgentMessageData,
    toolResults: Map<string, ToolResultMessage>,
    renderIndex: number,
  ): TemplateResult {
    const ts = formatTimestamp(message.timestamp);
    const blocks = this.asBlocks(message.content);
    const targetId = this.targetId(renderIndex);

    return html`
      <div class="assistant-message ml-assistant" id=${targetId}>
        ${this.renderCopyButton(targetId)}
        ${ts ? html`<div class="message-timestamp">${ts}</div>` : nothing}

        ${blocks.map((block) => {
          if (block.type === "text" && block.text?.trim()) {
            return html`<div class="assistant-text markdown-content">
              ${unsafeHTML(safeMarkedParse(block.text))}
            </div>`;
          }

          if (block.type === "thinking" && block.thinking?.trim()) {
            if (!this.showThinking) {
              return html`<div class="thinking-collapsed">Thinking…</div>`;
            }
            return html`<div class="thinking-block">
              <div class="thinking-text">${block.thinking}</div>
            </div>`;
          }

          if (block.type === "toolCall") {
            const result = block.id ? toolResults.get(block.id) : undefined;
            return html`${unsafeHTML(this.renderToolCall(block, result))}`;
          }

          return nothing;
        })}

        ${this.renderAssistantStopReason(message)}
      </div>
    `;
  }

  private renderOrphanToolResult(
    message: ToolResultMessage,
    renderIndex: number,
  ): TemplateResult {
    const status = message.isError ? "error" : "success";
    const ts = formatTimestamp(message.timestamp);
    const targetId = this.targetId(renderIndex);

    const output = this.getToolResultText(message).trim();
    const summary = this.singleLine(output || "(no output)");

    return html`
      <details
        class="tool-execution ${status} ml-tool tool-call-details"
        id=${targetId}
        ?open=${this.expandToolOutputs}
      >
        ${this.renderCopyButton(targetId)}
        ${ts ? html`<div class="message-timestamp">${ts}</div>` : nothing}
        <summary class="tool-call-summary">
          <span class="tool-call-summary-main">
            <span class="tool-name">${message.toolName || "tool"}</span>
            <span class="tool-call-summary-text">${summary}</span>
          </span>
          <span class="tool-call-summary-status">${status}</span>
        </summary>

        <div class="tool-call-body">
          ${unsafeHTML(
            output
              ? formatExpandableOutput(output, 10)
              : '<div class="tool-output"><div>(no output)</div></div>',
          )}
        </div>
      </details>
    `;
  }

  private renderBashExecution(
    message: BashExecutionMessage,
    renderIndex: number,
  ): TemplateResult {
    const ts = formatTimestamp(message.timestamp);
    const targetId = this.targetId(renderIndex);
    const output = (message.output || "").trim();
    const summary = this.singleLine(output || "(no output)");
    const status = message.cancelled
      ? "error"
      : typeof message.exitCode === "number" && message.exitCode !== 0
        ? "error"
        : "success";

    const metaBits: string[] = [];
    if (message.excludeFromContext) metaBits.push("not in context");
    if (typeof message.exitCode === "number") {
      metaBits.push(`exit ${message.exitCode}`);
    }
    if (message.truncated) metaBits.push("truncated");

    return html`
      <details
        class="tool-execution ${status} ml-tool tool-call-details bash-execution ${message.excludeFromContext
          ? "context-excluded"
          : ""}"
        id=${targetId}
        ?open=${this.expandToolOutputs}
      >
        ${this.renderCopyButton(targetId)}
        ${ts ? html`<div class="message-timestamp">${ts}</div>` : nothing}
        <summary class="tool-call-summary">
          <span class="tool-call-summary-main">
            <span class="tool-name">$ ${message.command || "(command)"}</span>
            <span class="tool-call-summary-text">${summary}</span>
          </span>
          <span class="tool-call-summary-status">
            ${metaBits.length > 0 ? metaBits.join(" · ") : status}
          </span>
        </summary>
        <div class="tool-call-body">
          ${unsafeHTML(
            output
              ? formatExpandableOutput(output, 10)
              : '<div class="tool-output"><div>(no output)</div></div>',
          )}
          ${message.fullOutputPath
            ? html`<div class="tool-meta-note">
                Full output: ${message.fullOutputPath}
              </div>`
            : nothing}
        </div>
      </details>
    `;
  }

  private renderAssistantStopReason(message: AgentMessageData): TemplateResult | typeof nothing {
    const stopReason =
      typeof message.stopReason === "string" ? message.stopReason : undefined;

    if (stopReason === "aborted") {
      return html`<div class="error-text">Aborted</div>`;
    }

    if (stopReason === "error") {
      const errorMessage =
        typeof message.errorMessage === "string"
          ? message.errorMessage
          : "Unknown error";
      return html`<div class="error-text">Error: ${errorMessage}</div>`;
    }

    return nothing;
  }

  private renderToolCall(
    block: MessageBlock,
    result?: ToolResultMessage,
  ): string {
    const id = block.id || "";
    const args = this.toRecord(block.arguments);
    const name = block.name || "tool";

    const pending = id ? this.pendingToolCalls.has(id) : false;
    const statusClass = result
      ? result.isError
        ? "error"
        : "success"
      : "pending";
    const statusLabel = result
      ? result.isError
        ? "error"
        : "done"
      : pending
        ? "running"
        : "no result";

    const invalidArg = '<span class="tool-error">[invalid arg]</span>';

    let summary = "";
    let body = "";

    switch (name) {
      case "bash": {
        const command = this.readString(args.command);
        const cmdDisplay = command === null ? invalidArg : escapeHtml(command || "...");
        summary = `$ ${cmdDisplay}`;

        body += `<div class="tool-section"><div class="tool-section-label">Input</div><div class="tool-command">$ ${cmdDisplay}</div></div>`;

        if (result) {
          const output = this.getToolResultText(result).trim();
          body += `<div class="tool-section"><div class="tool-section-label">Output</div>${
            output
              ? formatExpandableOutput(output, 8)
              : '<div class="tool-output"><div>(no output)</div></div>'
          }</div>`;
        }
        break;
      }

      case "read": {
        const filePath = this.readString(args.file_path ?? args.path);
        const offset = this.readNumber(args.offset);
        const limit = this.readNumber(args.limit);

        let pathHtml =
          filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ""));
        if (filePath !== null && (offset !== undefined || limit !== undefined)) {
          const start = offset ?? 1;
          const end = limit !== undefined ? start + limit - 1 : "";
          pathHtml += `<span class="line-numbers">:${start}${end ? `-${end}` : ""}</span>`;
        }

        summary = pathHtml || "(path missing)";
        body += `<div class="tool-section"><div class="tool-section-label">Input</div><div class="tool-header"><span class="tool-name">read</span> <span class="tool-path">${pathHtml}</span></div></div>`;

        if (result) {
          const output = this.getToolResultText(result);
          const lang = filePath ? getLanguageFromPath(filePath) : undefined;
          const images = this.renderResultImages(result.content);
          body += `<div class="tool-section"><div class="tool-section-label">Output</div>${images}${
            output.trim()
              ? formatExpandableOutput(output, 12, lang)
              : '<div class="tool-output"><div>(no output)</div></div>'
          }</div>`;
        }
        break;
      }

      case "write": {
        const filePath = this.readString(args.file_path ?? args.path);
        const content = this.readString(args.content);
        const path =
          filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ""));

        summary = path || "(path missing)";
        body += `<div class="tool-section"><div class="tool-section-label">Input</div><div class="tool-header"><span class="tool-name">write</span> <span class="tool-path">${path}</span></div></div>`;

        if (content === null) {
          body += `<div class="tool-section"><div class="tool-error">[invalid content arg - expected string]</div></div>`;
        } else if (content) {
          const lang = filePath ? getLanguageFromPath(filePath) : undefined;
          body += `<div class="tool-section"><div class="tool-section-label">Content</div>${formatExpandableOutput(content, 10, lang)}</div>`;
        }

        if (result) {
          const output = this.getToolResultText(result).trim();
          body += `<div class="tool-section"><div class="tool-section-label">Output</div>${
            output
              ? formatExpandableOutput(output, 10)
              : '<div class="tool-output"><div>(no output)</div></div>'
          }</div>`;
        }

        break;
      }

      case "edit": {
        const filePath = this.readString(args.file_path ?? args.path);
        const path =
          filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ""));
        summary = path || "(path missing)";

        body += `<div class="tool-section"><div class="tool-section-label">Input</div><div class="tool-header"><span class="tool-name">edit</span> <span class="tool-path">${path}</span></div></div>`;

        const oldText = this.readString(args.oldText ?? args.old_text);
        const newText = this.readString(args.newText ?? args.new_text);
        if (oldText && oldText !== null) {
          body += `<div class="tool-section"><div class="tool-section-label">Old text</div>${formatExpandableOutput(oldText, 8)}</div>`;
        }
        if (newText && newText !== null) {
          body += `<div class="tool-section"><div class="tool-section-label">New text</div>${formatExpandableOutput(newText, 8)}</div>`;
        }

        if (result) {
          const output = this.getToolResultText(result).trim();
          const diff =
            typeof result.details?.diff === "string" && result.details.diff
              ? result.details.diff
              : this.looksLikeDiff(output)
                ? output
                : "";

          if (diff) {
            body += `<div class="tool-section"><div class="tool-section-label">Diff</div>${this.renderDiff(diff)}</div>`;
          } else {
            body += `<div class="tool-section"><div class="tool-section-label">Output</div>${
              output
                ? formatExpandableOutput(output, 10)
                : '<div class="tool-output"><div>(no output)</div></div>'
            }</div>`;
          }
        }
        break;
      }

      default: {
        const renderedCall =
          this.readString(block.rendered?.callHtml ?? block.callHtml) || "";
        const renderedResult =
          this.readString(
            result?.rendered?.resultHtml ??
              result?.resultHtml ??
              block.rendered?.resultHtml ??
              block.resultHtml,
          ) || "";

        const argsJson = escapeHtml(JSON.stringify(args, null, 2));
        summary = this.singleLine(
          renderedCall
            ? this.stripHtml(renderedCall)
            : JSON.stringify(args).slice(0, 120),
        );

        if (renderedCall || renderedResult) {
          body += `<div class="tool-section"><div class="tool-section-label">Input</div>${
            renderedCall
              ? `<div class="tool-header ansi-rendered">${renderedCall}</div>`
              : `<div class="tool-output"><pre>${argsJson}</pre></div>`
          }</div>`;

          if (renderedResult) {
            const lines = renderedResult.split("\n");
            if (lines.length > 10) {
              const preview = lines.slice(0, 10).join("\n");
              body += `<div class="tool-section"><div class="tool-section-label">Output</div><div class="tool-output expandable ansi-rendered" onclick="this.classList.toggle('expanded')">
                <div class="output-preview">${preview}<div class="expand-hint">... (${lines.length - 10} more lines)</div></div>
                <div class="output-full">${renderedResult}</div>
              </div></div>`;
            } else {
              body += `<div class="tool-section"><div class="tool-section-label">Output</div><div class="tool-output ansi-rendered">${renderedResult}</div></div>`;
            }
          } else if (result) {
            const output = this.getToolResultText(result).trim();
            body += `<div class="tool-section"><div class="tool-section-label">Output</div>${
              output
                ? formatExpandableOutput(output, 10)
                : '<div class="tool-output"><div>(no output)</div></div>'
            }</div>`;
          }
        } else {
          body += `<div class="tool-section"><div class="tool-section-label">Input</div><div class="tool-output"><pre>${argsJson}</pre></div></div>`;
          if (result) {
            const output = this.getToolResultText(result).trim();
            body += `<div class="tool-section"><div class="tool-section-label">Output</div>${
              output
                ? formatExpandableOutput(output, 10)
                : '<div class="tool-output"><div>(no output)</div></div>'
            }</div>`;
          }
        }
      }
    }

    if (!result && pending) {
      body +=
        '<div class="tool-section"><div class="tool-section-label">Status</div><div class="tool-output"><div>Running…</div></div></div>';
    }

    const openAttr = this.expandToolOutputs ? " open" : "";
    return `<details class="tool-execution ${statusClass} tool-call-details"${openAttr}>
      <summary class="tool-call-summary">
        <span class="tool-call-summary-main">
          <span class="tool-name">${escapeHtml(name)}</span>
          <span class="tool-call-summary-text">${summary || "(no summary)"}</span>
        </span>
        <span class="tool-call-summary-status">${statusLabel}</span>
      </summary>
      <div class="tool-call-body">${body}</div>
    </details>`;
  }

  private renderDiff(diff: string): string {
    return `<div class="tool-diff">${diff
      .split("\n")
      .map((line) => {
        const cls = line.startsWith("+")
          ? "diff-added"
          : line.startsWith("-")
            ? "diff-removed"
            : "diff-context";
        return `<div class="${cls}">${escapeHtml(line)}</div>`;
      })
      .join("")}</div>`;
  }

  private renderResultImages(content: unknown): string {
    const blocks = this.asBlocks(content);
    const images = blocks.filter((part) => part.type === "image" && part.data);
    if (images.length === 0) return "";

    return `<div class="tool-images">${images
      .map((img) => {
        const mimeType = img.mimeType || "image/png";
        return `<img src="data:${escapeHtml(mimeType)};base64,${img.data}" class="tool-image" />`;
      })
      .join("")}</div>`;
  }

  private getToolResultText(result?: ToolResultMessage): string {
    if (!result) return "";
    const fromContent = this.getResultText(result.content).trim();
    const fromOutput = this.toPlainText(result.output).trim();

    if (fromContent && fromOutput && fromContent !== fromOutput) {
      return `${fromOutput}\n${fromContent}`.trim();
    }
    return fromOutput || fromContent;
  }

  private getResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    return this.asBlocks(content)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text || "")
      .join("\n");
  }

  private toPlainText(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (value == null) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private looksLikeDiff(text: string): boolean {
    if (!text.trim()) return false;
    const lines = text.split("\n").slice(0, 50);
    let markers = 0;
    for (const line of lines) {
      if (
        line.startsWith("diff --git") ||
        line.startsWith("@@") ||
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("+") ||
        line.startsWith("-")
      ) {
        markers++;
      }
      if (markers >= 3) return true;
    }
    return false;
  }

  private stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  private singleLine(value: string, max = 140): string {
    return value.replace(/\s+/g, " ").trim().slice(0, max);
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (content == null) return "";

    const blocks = this.asBlocks(content);
    if (blocks.length === 0) return String(content);

    return blocks
      .map((part) => {
        if (part.type === "text") return part.text || "";
        if (part.type === "thinking") return part.thinking || "";
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private asBlocks(content: unknown): MessageBlock[] {
    if (!Array.isArray(content)) return [];
    return content.filter((part) => part && typeof part === "object") as MessageBlock[];
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  }

  private readString(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (value == null) return "";
    return null;
  }

  private readNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return undefined;
  }
}
