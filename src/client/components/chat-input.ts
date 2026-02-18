import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { SlashCommandSpec } from "@shared/types.js";

@customElement("chat-input")
export class ChatInput extends LitElement {
  @property({ type: Boolean }) isStreaming = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Array }) commands: SlashCommandSpec[] = [];
  @property({ type: Boolean }) commandsLoading = false;

  @state() private text = "";
  @state() private selectedCommandIndex = 0;

  @query("textarea") private textarea!: HTMLTextAreaElement;

  static styles = css`
    :host {
      display: block;
      flex-shrink: 0;
      border-top: 1px solid var(--border);
      background: var(--surface);
      padding: 10px 14px;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
      font-family: var(--font, ui-monospace, monospace);
      position: relative;
    }

    .input-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      width: 100%;
      max-width: var(--max-width, 980px);
      margin: 0 auto;
      position: relative;
    }

    .input-wrap {
      flex: 1;
      position: relative;
      min-width: 0;
    }

    textarea {
      width: 100%;
      min-height: 40px;
      max-height: 180px;
      resize: none;
      overflow-y: auto;
      border: 1px solid var(--borderMuted, #505050);
      border-radius: 6px;
      padding: 10px 12px;
      background: var(--bg);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      line-height: 1.45;
      outline: none;
    }

    textarea::placeholder {
      color: var(--muted, #808080);
    }

    textarea:focus {
      border-color: var(--borderAccent, #00d7ff);
      box-shadow: 0 0 0 1px rgba(0, 215, 255, 0.25);
    }

    textarea:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .send-btn {
      width: 40px;
      height: 40px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--borderMuted, #505050);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      flex-shrink: 0;
    }

    .send-btn.send {
      border-color: var(--accent);
      color: var(--accent);
    }

    .send-btn.send:hover:not(:disabled) {
      background: var(--accent);
      color: var(--body-bg, #24252e);
    }

    .send-btn.send:disabled {
      opacity: 0.35;
      cursor: default;
    }

    .send-btn.stop {
      border-color: var(--error);
      color: var(--error);
    }

    .send-btn.stop:hover {
      background: var(--error);
      color: #111;
    }

    .input-help {
      max-width: var(--max-width, 980px);
      margin: 6px auto 0;
      color: var(--text-secondary);
      font-size: 11px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .commands-popover {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 6px);
      border: 1px solid var(--borderMuted, #505050);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow-lg);
      max-height: 260px;
      overflow: auto;
      z-index: 20;
    }

    .commands-popover-header {
      padding: 8px 10px;
      border-bottom: 1px solid var(--borderMuted, #505050);
      color: var(--text-secondary);
      font-size: 11px;
    }

    .command-item {
      width: 100%;
      border: none;
      border-bottom: 1px solid rgba(128, 128, 128, 0.12);
      background: transparent;
      color: var(--text-primary);
      padding: 8px 10px;
      text-align: left;
      cursor: pointer;
      display: grid;
      gap: 3px;
      font: inherit;
    }

    .command-item:last-child {
      border-bottom: none;
    }

    .command-item:hover,
    .command-item.active {
      background: var(--surface-alt);
    }

    .command-name {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }

    .command-source {
      color: var(--text-secondary);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border: 1px solid var(--borderMuted, #505050);
      border-radius: 999px;
      padding: 1px 6px;
    }

    .command-description {
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;

  render() {
    const suggestions = this.commandSuggestions;
    const showSuggestions = suggestions.length > 0;

    return html`
      <div class="input-row">
        <div class="input-wrap">
          ${showSuggestions
            ? html`
                <div class="commands-popover" role="listbox" aria-label="Slash commands">
                  <div class="commands-popover-header">
                    Commands (${suggestions.length})
                  </div>
                  ${suggestions.map(
                    (cmd, index) => html`
                      <button
                        class="command-item ${index === this.selectedCommandIndex
                          ? "active"
                          : ""}"
                        @mousedown=${(e: MouseEvent) => e.preventDefault()}
                        @click=${() => this.applyCommandSuggestion(index)}
                      >
                        <div class="command-name">
                          <strong>/${cmd.name}</strong>
                          <span class="command-source">${cmd.source}</span>
                        </div>
                        ${cmd.description
                          ? html`<div class="command-description">
                              ${cmd.description}
                            </div>`
                          : nothing}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing}

          <textarea
            placeholder=${this.disabled
              ? "No model available"
              : "Type a message… (!cmd, !!cmd, /command)"}
            rows="1"
            .value=${this.text}
            ?disabled=${this.disabled}
            @input=${this.onInput}
            @keydown=${this.onKeydown}
          ></textarea>
        </div>

        ${this.isStreaming
          ? html`
              <button class="send-btn stop" @click=${this.onStop} title="Stop">
                &#9632;
              </button>
            `
          : html`
              <button
                class="send-btn send"
                @click=${this.onSend}
                ?disabled=${this.disabled || !this.text.trim()}
                title="Send"
              >
                &#9654;
              </button>
            `}
      </div>

      <div class="input-help">
        <span>Enter: send</span>
        <span>Shift+Enter: newline</span>
        ${this.isStreaming
          ? html`<span>Alt+Enter: follow-up</span>`
          : nothing}
        <span>!cmd: shell + context</span>
        <span>!!cmd: shell only</span>
        <span
          >/: commands${this.commandsLoading
            ? " (loading…)"
            : this.commands.length
              ? ` (${this.commands.length})`
              : ""}</span
        >
      </div>
    `;
  }

  private onInput(e: InputEvent) {
    const ta = e.target as HTMLTextAreaElement;
    this.text = ta.value;
    this.selectedCommandIndex = 0;
    this.syncHeight(ta);
  }

  private onKeydown(e: KeyboardEvent) {
    const suggestions = this.commandSuggestions;
    const showSuggestions = suggestions.length > 0;

    if (showSuggestions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.selectedCommandIndex = Math.min(
          this.selectedCommandIndex + 1,
          suggestions.length - 1,
        );
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.selectedCommandIndex = Math.max(this.selectedCommandIndex - 1, 0);
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        this.applyCommandSuggestion(this.selectedCommandIndex);
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.applyCommandSuggestion(this.selectedCommandIndex);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();

      if (this.isStreaming) {
        if (!this.text.trim()) return;

        if (e.altKey) {
          this.dispatchEvent(
            new CustomEvent("follow-up", { detail: this.text.trim() }),
          );
          this.clear();
          return;
        }

        this.dispatchEvent(new CustomEvent("steer", { detail: this.text.trim() }));
        this.clear();
        return;
      }

      this.onSend();
    }
  }

  private onSend() {
    const text = this.text.trim();
    if (!text) return;
    this.dispatchEvent(new CustomEvent("send", { detail: text }));
    this.clear();
  }

  private onStop() {
    this.dispatchEvent(new CustomEvent("stop"));
  }

  private clear() {
    this.text = "";
    this.selectedCommandIndex = 0;
    if (this.textarea) {
      this.textarea.style.height = "auto";
    }
  }

  focusInput() {
    this.textarea?.focus();
  }

  setText(value: string) {
    this.text = value;
    this.selectedCommandIndex = 0;
    this.updateComplete.then(() => {
      if (!this.textarea) return;
      this.textarea.value = value;
      this.syncHeight(this.textarea);
      this.textarea.focus();
      const end = this.textarea.value.length;
      this.textarea.setSelectionRange(end, end);
    });
  }

  getText(): string {
    return this.text;
  }

  private syncHeight(ta: HTMLTextAreaElement) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
  }

  private applyCommandSuggestion(index: number) {
    const cmd = this.commandSuggestions[index];
    if (!cmd) return;

    const rest = this.text.replace(/^\/\S*/, "").trimStart();
    this.text = rest ? `/${cmd.name} ${rest}` : `/${cmd.name} `;
    this.selectedCommandIndex = 0;

    this.updateComplete.then(() => {
      if (!this.textarea) return;
      this.textarea.value = this.text;
      this.syncHeight(this.textarea);
      this.textarea.focus();
      const end = this.textarea.value.length;
      this.textarea.setSelectionRange(end, end);
    });
  }

  private get commandSuggestions(): SlashCommandSpec[] {
    const query = this.commandQuery;
    if (query == null) return [];

    const normalized = query.toLowerCase();
    const ranked = this.commands
      .filter((cmd) => {
        const name = cmd.name.toLowerCase();
        if (!normalized) return true;
        return (
          name.startsWith(normalized) ||
          name.includes(normalized) ||
          (cmd.description || "").toLowerCase().includes(normalized)
        );
      })
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(normalized) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(normalized) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
      });

    return ranked.slice(0, 12);
  }

  private get commandQuery(): string | null {
    if (!this.text.startsWith("/")) return null;

    const firstLine = this.text.split("\n", 1)[0];
    const withoutSlash = firstLine.slice(1);

    // Once arguments are typed, hide completion popup.
    if (/\s/.test(withoutSlash)) return null;

    const firstToken = withoutSlash.split(/\s+/, 1)[0];
    if (firstToken == null) return null;

    return firstToken.trim();
  }
}
