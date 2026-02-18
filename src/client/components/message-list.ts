import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { AgentMessageData } from "@shared/types.js";

interface ContentPart {
  type?: string;
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

@customElement("message-list")
export class MessageList extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Array }) messages: AgentMessageData[] = [];
  @property({ type: Boolean }) isStreaming = false;
  @property({ attribute: false }) pendingToolCalls = new Set<string>();

  render() {
    const visible = this.messages.filter((m) => m.role !== "artifact");

    return html`
      <div class="ml-list">
        ${visible.map((m) => this.renderMessage(m))}
      </div>
    `;
  }

  private renderMessage(message: AgentMessageData) {
    const role = message.role;

    if (role === "user" || role === "user-with-attachments") {
      return html`
        <div class="ml-row ml-row-user">
          <div class="ml-msg ml-user">${this.renderUserContent(message)}</div>
        </div>
      `;
    }

    if (role === "assistant") {
      return html`
        <div class="ml-row ml-row-assistant">
          <div class="ml-msg ml-assistant">
            ${this.renderAssistantContent(message.content)}
          </div>
        </div>
      `;
    }

    if (role === "toolResult") {
      return html`
        <div class="ml-row ml-row-tool">
          <div class="ml-msg ml-tool">${this.renderToolResult(message)}</div>
        </div>
      `;
    }

    return nothing;
  }

  private renderUserContent(message: AgentMessageData) {
    const text = this.extractText(message.content);
    return html`<div class="ml-text">${text}</div>`;
  }

  private renderAssistantContent(content: unknown) {
    if (typeof content === "string") {
      return html`<div class="ml-text">${content}</div>`;
    }

    if (!Array.isArray(content)) {
      return html`<div class="ml-text">${String(content ?? "")}</div>`;
    }

    const parts = content as ContentPart[];
    return html`
      ${parts.map((part) => {
        if (part?.type === "thinking") {
          return html`<div class="ml-thinking">${part.thinking || ""}</div>`;
        }
        if (part?.type === "toolCall") {
          return html`
            <div class="ml-toolcall">
              Tool: ${part.name || "unknown"}${this.pendingToolCalls.has(String(part.id || ""))
                ? " (running…)"
                : ""}
            </div>
          `;
        }

        const text = part?.type === "text" ? part.text || "" : this.extractText(part);
        return html`<div class="ml-text">${text}</div>`;
      })}
    `;
  }

  private renderToolResult(message: AgentMessageData) {
    return html`<div class="ml-text">${this.extractText(message.content)}</div>`;
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (content == null) return "";

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const p = part as Record<string, unknown>;
          if (p.type === "text") return String(p.text || "");
          if (p.type === "thinking") return String(p.thinking || "");
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
    }

    if (typeof content === "object") {
      const c = content as Record<string, unknown>;
      if (typeof c.text === "string") return c.text;
      if (typeof c.thinking === "string") return c.thinking;
    }

    return String(content);
  }
}
