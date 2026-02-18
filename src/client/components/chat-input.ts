import { LitElement, html, css } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";

@customElement("chat-input")
export class ChatInput extends LitElement {
  @property({ type: Boolean }) isStreaming = false;
  @property({ type: Boolean }) disabled = false;
  @state() private text = "";
  @query("textarea") private textarea!: HTMLTextAreaElement;

  static styles = css`
    :host {
      display: block;
      flex-shrink: 0;
      border-top: 1px solid var(--border);
      background: var(--surface);
      padding: 12px 16px;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }

    .input-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      max-width: var(--max-width);
      margin: 0 auto;
    }

    textarea {
      flex: 1;
      resize: none;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 12px;
      font-family: inherit;
      font-size: 1rem;
      line-height: 1.5;
      background: var(--bg);
      color: var(--text-primary);
      outline: none;
      min-height: 44px;
      max-height: 120px;
      overflow-y: auto;
    }

    textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
    }

    textarea::placeholder {
      color: var(--text-secondary);
    }

    .send-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
      flex-shrink: 0;
      font-size: 1.1rem;
      transition: background 0.1s ease;
    }

    .send-btn.send {
      background: var(--accent);
      color: white;
    }

    .send-btn.send:hover:not(:disabled) {
      background: var(--accent-hover);
    }

    .send-btn.send:disabled {
      opacity: 0.4;
      cursor: default;
    }

    textarea:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .send-btn.stop {
      background: var(--error);
      color: white;
    }

    .send-btn.stop:hover {
      opacity: 0.9;
    }
  `;

  render() {
    return html`
      <div class="input-row">
        <textarea
          placeholder=${this.disabled ? "No model available" : "Type a message..."}
          rows="1"
          .value=${this.text}
          ?disabled=${this.disabled}
          @input=${this.onInput}
          @keydown=${this.onKeydown}
        ></textarea>
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
    `;
  }

  private onInput(e: InputEvent) {
    const ta = e.target as HTMLTextAreaElement;
    this.text = ta.value;
    // Auto-resize
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }

  private onKeydown(e: KeyboardEvent) {
    // Enter sends (desktop), Shift+Enter for newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (this.isStreaming) {
        // Steer
        if (this.text.trim()) {
          this.dispatchEvent(
            new CustomEvent("steer", { detail: this.text.trim() }),
          );
          this.clear();
        }
      } else {
        this.onSend();
      }
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
    if (this.textarea) {
      this.textarea.style.height = "auto";
    }
  }

  /** Focus the textarea (called externally). */
  focusInput() {
    this.textarea?.focus();
  }
}
