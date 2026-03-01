import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { SlashCommandSpec, ImageContent } from "@shared/types.js";

const MAX_PASTED_IMAGES = 6;
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ChatInputSubmitDetail {
  text: string;
  images: ImageContent[];
}

export interface ChatInputDraftDetail {
  text: string;
}

@customElement("chat-input")
export class ChatInput extends LitElement {
  @property({ type: Boolean }) isStreaming = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Array }) commands: SlashCommandSpec[] = [];
  @property({ type: Boolean }) commandsLoading = false;
  @property({ type: String }) placeholder = "Prompt…";

  @state() private text = "";
  @state() private selectedCommandIndex = 0;
  @state() private pastedImages: ImageContent[] = [];
  @state() private attachmentError = "";
  @state() private processingPaste = false;
  @state() private isDragOver = false;

  private dragDepth = 0;

  @query("textarea") private textarea!: HTMLTextAreaElement;
  @query(".file-input") private fileInput?: HTMLInputElement;

  static styles = css`
    :host {
      display: block;
      flex-shrink: 0;
      width: 100%;
      min-width: 0;
      overflow: hidden;
      border-top: 1px solid var(--borderSubtle, var(--borderMuted, #505050));
      border-bottom: 1px solid var(--borderSubtle, var(--borderMuted, #505050));
      background: var(--surface);
      font-family: var(--font, ui-monospace, monospace);
      position: relative;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    :host(:focus-within) {
      border-top-color: var(--purpose, var(--borderAccent, #00d7ff));
      border-bottom-color: var(--purpose, var(--borderAccent, #00d7ff));
    }

    .input-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      width: 100%;
      min-width: 0;
      padding: 10px 14px;
      padding-bottom: max(
        10px,
        env(safe-area-inset-bottom),
        env(keyboard-inset-height, 0px)
      );
      position: relative;
    }

    .drop-overlay {
      position: absolute;
      inset: 0;
      border: 1px dashed var(--accent);
      border-radius: 8px;
      background: rgba(0, 215, 255, 0.08);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      pointer-events: none;
      z-index: 30;
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
      min-height: 36px;
      max-height: 180px;
      resize: none;
      overflow-y: auto;
      overflow-x: hidden;
      border: none;
      border-radius: 0;
      padding: 8px 0;
      background: transparent;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      line-height: 1.45;
      overflow-wrap: anywhere;
      word-break: break-word;
      outline: none;
    }

    @media (max-width: 980px) and (pointer: coarse) {
      textarea {
        font-size: 16px;
        min-height: 36px;
        max-height: 180px;
      }

      textarea:focus {
        min-height: 96px;
        max-height: 220px;
        min-height: min(32dvh, 140px);
        max-height: min(42dvh, 220px);
      }
    }

    textarea::placeholder {
      color: var(--muted, #808080);
    }

    textarea:focus {
      box-shadow: none;
    }

    textarea.drag-over {
      background: rgba(0, 215, 255, 0.06);
    }

    textarea:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .attach-btn,
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

    .attach-btn:hover:not(:disabled) {
      border-color: var(--accent);
      color: var(--accent);
    }

    .attach-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }

    .mobile-actions .attach-btn {
      display: none;
    }

    :host(:focus-within) .mobile-actions .attach-btn {
      display: inline-flex;
    }

    .input-row:not(:has(textarea:focus)) .mobile-actions .attach-btn {
      display: none;
    }

    .mobile-actions .continue-btn {
      display: none;
    }

    :host(.agent-idle) .mobile-actions .continue-btn {
      display: inline-flex;
    }

    .file-input {
      display: none;
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

    .mobile-actions {
      display: none;
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

    @media (max-width: 980px) {
      .input-wrap {
        padding-right: 44px;
      }

      .mobile-actions {
        position: absolute;
        right: 14px;
        bottom: max(
          10px,
          env(safe-area-inset-bottom),
          env(keyboard-inset-height, 0px)
        );
        display: flex;
        flex-direction: column;
        gap: 6px;
        z-index: 10;
      }

      .attach-btn,
      .send-btn {
        width: 32px;
        height: 32px;
        font-size: 12px;
        background: var(--surface-alt);
      }
    }

    :host,
    :host * {
      font-size: var(--ui-font-size, 12px);
    }

    @media (max-width: 980px) and (pointer: coarse) {
      :host textarea {
        font-size: 16px;
      }
    }
  `;

  render() {
    const suggestions = this.commandSuggestions;
    const showSuggestions = suggestions.length > 0;

    return html`
      <div
        class="input-row"
        @dragenter=${this.onDropZoneDragEnter}
        @dragover=${this.onDropZoneDragOver}
        @dragleave=${this.onDropZoneDragLeave}
        @drop=${this.onDropZoneDrop}
      >
        ${this.isDragOver
          ? html`<div class="drop-overlay">Drop images to attach</div>`
          : nothing}

        <input
          class="file-input"
          type="file"
          accept="image/*"
          multiple
          @change=${this.onFileInputChange}
          ?disabled=${this.disabled}
        />

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
            placeholder=${this.placeholder}
            rows="1"
            .value=${this.text}
            ?disabled=${this.disabled}
            @input=${this.onInput}
            @keydown=${this.onKeydown}
            @paste=${this.onPaste}
          ></textarea>
        </div>

        <div class="mobile-actions">
          <button
            class="attach-btn"
            @click=${this.onAttachClick}
            ?disabled=${
              this.disabled ||
              this.processingPaste ||
              this.pastedImages.length >= MAX_PASTED_IMAGES
            }
            title="Attach image"
          >
            📎
          </button>

          ${!this.text.trim() && this.pastedImages.length === 0
            ? html`
                <button
                  class="send-btn continue-btn"
                  @click=${this.onContinue}
                  ?disabled=${this.disabled || this.processingPaste}
                  title="Continue"
                >
                  ⏭
                </button>
              `
            : nothing}

          ${this.text.trim() || this.pastedImages.length > 0
            ? html`
                <button
                  class="send-btn send"
                  @click=${this.onSend}
                  ?disabled=${this.disabled || this.processingPaste}
                  title="Send"
                >
                  &#9654;
                </button>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private onInput(e: InputEvent) {
    const ta = e.target as HTMLTextAreaElement;
    this.text = ta.value;
    this.selectedCommandIndex = 0;
    this.syncHeight(ta);
    this.emitDraftChange();
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

  private onContinue() {
    if (this.processingPaste || this.disabled) return;

    this.dispatchEvent(
      new CustomEvent<ChatInputSubmitDetail>("send", {
        detail: { text: "continue", images: [] },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async onPaste(e: ClipboardEvent) {
    if (this.disabled) return;

    const imageFiles = this.extractImageFilesFromClipboard(e.clipboardData);
    if (imageFiles.length === 0) return;

    e.preventDefault();
    await this.addImageFiles(imageFiles);
  }

  private onDropZoneDragEnter(e: DragEvent) {
    if (this.disabled) return;

    const transfer = e.dataTransfer;
    if (!transfer || !this.hasFileTransfer(transfer)) return;

    e.preventDefault();
    this.dragDepth += 1;
    if (!this.isDragOver) {
      this.isDragOver = true;
    }
  }

  private onDropZoneDragOver(e: DragEvent) {
    if (this.disabled) return;

    const transfer = e.dataTransfer;
    if (!transfer || !this.hasFileTransfer(transfer)) return;

    e.preventDefault();
    transfer.dropEffect = "copy";
  }

  private onDropZoneDragLeave(e: DragEvent) {
    if (this.disabled) return;

    const transfer = e.dataTransfer;
    if (!transfer || !this.hasFileTransfer(transfer)) return;

    e.preventDefault();

    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.isDragOver = false;
    }
  }

  private async onDropZoneDrop(e: DragEvent) {
    this.dragDepth = 0;
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

  private onAttachClick() {
    if (this.disabled || this.processingPaste) return;

    this.attachmentError = "";
    this.fileInput?.click();
  }

  private async onFileInputChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = "";

    if (files.length === 0) return;

    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      this.attachmentError = "Only image files can be attached.";
      return;
    }

    if (imageFiles.length !== files.length) {
      this.attachmentError = "Only image files were attached.";
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
    if (this.processingPaste) return;

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
    this.dragDepth = 0;
    this.emitDraftChange();
    if (this.textarea) {
      this.textarea.style.height = "auto";
      // Blur on mobile so the textarea collapses back to its default size
      this.textarea.blur();
    }
  }

  focusInput() {
    this.textarea?.focus();
  }

  setText(value: string, options?: { focus?: boolean }) {
    this.text = value;
    this.selectedCommandIndex = 0;
    this.emitDraftChange();
    this.updateComplete.then(() => {
      if (!this.textarea) return;
      this.textarea.value = value;
      this.syncHeight(this.textarea);
      if (options?.focus !== false) {
        this.textarea.focus();
        const end = this.textarea.value.length;
        this.textarea.setSelectionRange(end, end);
      }
    });
  }

  getText(): string {
    return this.text;
  }

  private emitDraftChange() {
    this.dispatchEvent(
      new CustomEvent<ChatInputDraftDetail>("draft-change", {
        detail: { text: this.text },
        bubbles: true,
        composed: true,
      }),
    );
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
