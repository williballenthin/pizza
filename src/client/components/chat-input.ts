import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { SlashCommandSpec, ImageContent } from "@shared/types.js";

const MAX_PASTED_IMAGES = 6;
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ChatInputSubmitDetail {
  text: string;
  images: ImageContent[];
}

@customElement("chat-input")
export class ChatInput extends LitElement {
  @property({ type: Boolean }) isStreaming = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Array }) commands: SlashCommandSpec[] = [];
  @property({ type: Boolean }) commandsLoading = false;

  @state() private text = "";
  @state() private selectedCommandIndex = 0;
  @state() private pastedImages: ImageContent[] = [];
  @state() private attachmentError = "";
  @state() private processingPaste = false;
  @state() private isDragOver = false;

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

    .attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }

    .attachment {
      width: 72px;
      height: 72px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--borderMuted, #505050);
      position: relative;
      background: var(--bg);
    }

    .attachment img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .attachment-remove {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 18px;
      height: 18px;
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.65);
      color: #fff;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .attachment-error {
      margin-bottom: 8px;
      color: var(--error);
      font-size: 11px;
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

    textarea.drag-over {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px rgba(0, 215, 255, 0.25);
      background: rgba(0, 215, 255, 0.06);
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

          ${this.attachmentError
            ? html`<div class="attachment-error">${this.attachmentError}</div>`
            : nothing}

          ${this.pastedImages.length > 0
            ? html`<div class="attachments">
                ${this.pastedImages.map(
                  (img, index) => html`
                    <div class="attachment" title=${img.mimeType}>
                      <img
                        src=${`data:${img.mimeType};base64,${img.data}`}
                        alt="Pasted image"
                      />
                      <button
                        class="attachment-remove"
                        title="Remove image"
                        @click=${() => this.removeImage(index)}
                      >
                        ×
                      </button>
                    </div>
                  `,
                )}
              </div>`
            : nothing}

          <textarea
            class=${this.isDragOver ? "drag-over" : ""}
            placeholder=${this.disabled
              ? "No model available"
              : "Type a message… (!cmd, !!cmd, /command)"}
            rows="1"
            .value=${this.text}
            ?disabled=${this.disabled}
            @input=${this.onInput}
            @keydown=${this.onKeydown}
            @paste=${this.onPaste}
            @dragover=${this.onDragOver}
            @dragleave=${this.onDragLeave}
            @drop=${this.onDrop}
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
                ?disabled=${
                  this.disabled ||
                  this.processingPaste ||
                  (!this.text.trim() && this.pastedImages.length === 0)
                }
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
        <span>Cmd/Ctrl+V: paste image</span>
        <span>Drag & drop: image attach</span>
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

      if (this.processingPaste) return;

      const detail = this.buildSubmitDetail();
      if (!detail) return;

      if (this.isStreaming) {
        if (e.altKey) {
          this.dispatchEvent(
            new CustomEvent<ChatInputSubmitDetail>("follow-up", {
              detail,
              bubbles: true,
              composed: true,
            }),
          );
          this.clear();
          return;
        }

        this.dispatchEvent(
          new CustomEvent<ChatInputSubmitDetail>("steer", {
            detail,
            bubbles: true,
            composed: true,
          }),
        );
        this.clear();
        return;
      }

      this.onSend();
    }
  }

  private onSend() {
    if (this.processingPaste) return;
    const detail = this.buildSubmitDetail();
    if (!detail) return;

    this.dispatchEvent(
      new CustomEvent<ChatInputSubmitDetail>("send", {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
    this.clear();
  }

  private onStop() {
    this.dispatchEvent(
      new CustomEvent("stop", { bubbles: true, composed: true }),
    );
  }

  private async onPaste(e: ClipboardEvent) {
    if (this.disabled) return;

    const imageFiles = this.extractImageFilesFromClipboard(e.clipboardData);
    if (imageFiles.length === 0) return;

    e.preventDefault();
    await this.addImageFiles(imageFiles);
  }

  private onDragOver(e: DragEvent) {
    if (this.disabled) return;
    const transfer = e.dataTransfer;
    if (!transfer || !this.hasFileTransfer(transfer)) return;

    e.preventDefault();
    transfer.dropEffect = "copy";
    if (!this.isDragOver) {
      this.isDragOver = true;
    }
  }

  private onDragLeave() {
    this.isDragOver = false;
  }

  private async onDrop(e: DragEvent) {
    this.isDragOver = false;

    if (this.disabled) return;
    const transfer = e.dataTransfer;
    if (!transfer || !this.hasFileTransfer(transfer)) return;

    e.preventDefault();

    const imageFiles = this.extractImageFilesFromTransfer(transfer);
    if (imageFiles.length === 0) {
      this.attachmentError = "Only image files can be attached.";
      return;
    }

    await this.addImageFiles(imageFiles);
  }

  private extractImageFilesFromClipboard(data: DataTransfer | null): File[] {
    if (!data?.items) return [];

    const files: File[] = [];
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    return files;
  }

  private hasFileTransfer(transfer: DataTransfer): boolean {
    return Array.from(transfer.types || []).includes("Files");
  }

  private extractImageFilesFromTransfer(transfer: DataTransfer): File[] {
    return Array.from(transfer.files || []).filter((file) =>
      file.type.startsWith("image/"),
    );
  }

  private async addImageFiles(files: File[]) {
    this.attachmentError = "";

    const remainingSlots = MAX_PASTED_IMAGES - this.pastedImages.length;
    if (remainingSlots <= 0) {
      this.attachmentError = `Maximum ${MAX_PASTED_IMAGES} images per message.`;
      return;
    }

    const filesToProcess = files.slice(0, remainingSlots);
    if (files.length > filesToProcess.length) {
      this.attachmentError = `Only ${MAX_PASTED_IMAGES} images allowed per message.`;
    }

    this.processingPaste = true;
    const nextImages = [...this.pastedImages];

    try {
      for (const file of filesToProcess) {
        if (file.size > MAX_PASTED_IMAGE_BYTES) {
          this.attachmentError = `Image too large. Max size is ${Math.round(MAX_PASTED_IMAGE_BYTES / 1024 / 1024)}MB.`;
          continue;
        }

        try {
          const base64 = await this.fileToBase64(file);
          nextImages.push({
            type: "image",
            data: base64,
            mimeType: file.type || "image/png",
          });
        } catch {
          this.attachmentError = "Failed to read image attachment.";
        }
      }

      this.pastedImages = nextImages;
    } finally {
      this.processingPaste = false;
    }
  }

  private clear() {
    this.text = "";
    this.selectedCommandIndex = 0;
    this.pastedImages = [];
    this.attachmentError = "";
    this.isDragOver = false;
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

  private buildSubmitDetail(): ChatInputSubmitDetail | null {
    const text = this.text.trim();
    const images = [...this.pastedImages];
    if (!text && images.length === 0) return null;
    return { text, images };
  }

  private removeImage(index: number) {
    this.pastedImages = this.pastedImages.filter((_, i) => i !== index);
    this.attachmentError = "";
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

  private async fileToBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
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
