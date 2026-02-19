import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { QueueDeliveryMode } from "@shared/types.js";

const QUEUE_MODES: QueueDeliveryMode[] = ["one-at-a-time", "all"];

@customElement("settings-panel")
export class SettingsPanel extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ type: String }) currentSteeringMode: QueueDeliveryMode =
    "one-at-a-time";
  @property({ type: String }) currentFollowUpMode: QueueDeliveryMode =
    "one-at-a-time";
  @property({ type: Boolean }) showThinking = true;
  @property({ type: Boolean }) expandToolOutputs = false;

  @state() private theme: string =
    localStorage.getItem("pi-theme") || "auto";

  static styles = css`
    :host {
      display: block;
    }

    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 99;
    }

    /* Mobile: full-height slide-in from right */
    .panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(320px, 85vw);
      background: var(--surface);
      border-left: 1px solid var(--border);
      box-shadow: var(--shadow-lg);
      z-index: 100;
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.2s ease;
    }

    .panel.open {
      transform: translateX(0);
    }

    /* Desktop (>= 768px): dropdown anchored top-right */
    @media (min-width: 768px) {
      .panel {
        position: fixed;
        top: 56px;
        right: 16px;
        bottom: auto;
        width: 320px;
        max-height: calc(100vh - 80px);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        transform: translateY(-8px);
        opacity: 0;
        pointer-events: none;
        transition: transform 0.15s ease, opacity 0.15s ease;
      }

      .panel.open {
        transform: translateY(0);
        opacity: 1;
        pointer-events: auto;
      }
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }

    .panel-header h2 {
      font-size: 1.1rem;
      font-weight: 600;
    }

    .close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: none;
      background: none;
      cursor: pointer;
      border-radius: var(--radius);
      color: var(--text-primary);
      font-size: 1.2rem;
    }

    .close-btn:hover {
      background: var(--surface-alt);
    }

    .panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
    }

    .field {
      margin-bottom: 20px;
    }

    .field label {
      display: block;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      margin-bottom: 6px;
    }

    /* Segmented controls */
    .segmented {
      display: flex;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .seg-btn {
      flex: 1;
      padding: 8px 4px;
      border: none;
      background: var(--bg);
      color: var(--text-primary);
      font-size: 0.75rem;
      cursor: pointer;
      text-align: center;
      font-family: inherit;
      border-right: 1px solid var(--border);
      min-height: 38px;
    }

    .seg-btn:last-child {
      border-right: none;
    }

    .seg-btn:hover {
      background: var(--surface-alt);
    }

    .seg-btn.active {
      background: var(--accent);
      color: white;
    }

    /* Theme radio buttons */
    .theme-options {
      display: flex;
      gap: 8px;
    }

    .theme-btn {
      flex: 1;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text-primary);
      font-size: 0.9rem;
      cursor: pointer;
      text-align: center;
      font-family: inherit;
      min-height: 44px;
    }

    .theme-btn:hover {
      background: var(--surface-alt);
    }

    .theme-btn.active {
      border-color: var(--accent);
      background: var(--surface-alt);
    }
  `;

  render() {
    return html`
      ${this.open
        ? html`<div class="backdrop" @click=${this.close}></div>`
        : nothing}
      <div class="panel ${this.open ? "open" : ""}">
        <div class="panel-header">
          <h2>Settings</h2>
          <button class="close-btn" @click=${this.close}>&times;</button>
        </div>
        <div class="panel-body">
          <div class="field">
            <label>Show Thinking</label>
            <div class="segmented">
              <button
                class="seg-btn ${this.showThinking ? "active" : ""}"
                @click=${() => this.onShowThinkingChange(true)}
              >
                Show
              </button>
              <button
                class="seg-btn ${!this.showThinking ? "active" : ""}"
                @click=${() => this.onShowThinkingChange(false)}
              >
                Hide
              </button>
            </div>
          </div>

          <div class="field">
            <label>Tool Outputs</label>
            <div class="segmented">
              <button
                class="seg-btn ${this.expandToolOutputs ? "active" : ""}"
                @click=${() => this.onExpandToolOutputsChange(true)}
              >
                Expanded
              </button>
              <button
                class="seg-btn ${!this.expandToolOutputs ? "active" : ""}"
                @click=${() => this.onExpandToolOutputsChange(false)}
              >
                Collapsed
              </button>
            </div>
          </div>

          <div class="field">
            <label>Steering Queue</label>
            <div class="segmented">
              ${QUEUE_MODES.map(
                (mode) => html`
                  <button
                    class="seg-btn ${this.currentSteeringMode === mode
                      ? "active"
                      : ""}"
                    @click=${() => this.onSteeringModeChange(mode)}
                  >
                    ${mode}
                  </button>
                `,
              )}
            </div>
          </div>

          <div class="field">
            <label>Follow-up Queue</label>
            <div class="segmented">
              ${QUEUE_MODES.map(
                (mode) => html`
                  <button
                    class="seg-btn ${this.currentFollowUpMode === mode
                      ? "active"
                      : ""}"
                    @click=${() => this.onFollowUpModeChange(mode)}
                  >
                    ${mode}
                  </button>
                `,
              )}
            </div>
          </div>

          <div class="field">
            <label>Theme</label>
            <div class="theme-options">
              ${(["auto", "light", "dark"] as const).map(
                (t) => html`
                  <button
                    class="theme-btn ${this.theme === t ? "active" : ""}"
                    @click=${() => this.onThemeChange(t)}
                  >
                    ${t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                `,
              )}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private close() {
    this.dispatchEvent(new CustomEvent("close"));
  }

  private onSteeringModeChange(mode: QueueDeliveryMode) {
    this.dispatchEvent(
      new CustomEvent("steering-mode-change", { detail: mode }),
    );
  }

  private onFollowUpModeChange(mode: QueueDeliveryMode) {
    this.dispatchEvent(
      new CustomEvent("follow-up-mode-change", { detail: mode }),
    );
  }

  private onShowThinkingChange(show: boolean) {
    this.dispatchEvent(
      new CustomEvent("show-thinking-change", { detail: show }),
    );
  }

  private onExpandToolOutputsChange(expand: boolean) {
    this.dispatchEvent(
      new CustomEvent("expand-tool-outputs-change", { detail: expand }),
    );
  }

  private onThemeChange(theme: "auto" | "light" | "dark") {
    this.theme = theme;
    if (theme === "auto") {
      localStorage.removeItem("pi-theme");
    } else {
      localStorage.setItem("pi-theme", theme);
    }
    // Delegate to shared theme logic (syncs data-theme + .dark class)
    const applyTheme = (window as unknown as Record<string, unknown>)
      .__applyTheme as ((t: string | null) => void) | undefined;
    if (applyTheme) {
      applyTheme(theme === "auto" ? null : theme);
    }
  }
}
