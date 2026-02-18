import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  ModelInfo,
  ThinkingLevel,
  QueueDeliveryMode,
} from "@shared/types.js";

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const QUEUE_MODES: QueueDeliveryMode[] = ["one-at-a-time", "all"];

@customElement("settings-panel")
export class SettingsPanel extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ type: String }) currentModel = "";
  @property({ type: String }) currentProvider = "";
  @property({ type: String }) currentThinkingLevel: ThinkingLevel = "off";
  @property({ type: String }) currentSteeringMode: QueueDeliveryMode =
    "one-at-a-time";
  @property({ type: String }) currentFollowUpMode: QueueDeliveryMode =
    "one-at-a-time";
  @property({ type: Array }) models: ModelInfo[] = [];

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

    select {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.95rem;
      appearance: auto;
      min-height: 44px;
    }

    select:focus {
      outline: none;
      border-color: var(--accent);
    }

    /* Segmented control for thinking level */
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
            <label>Model</label>
            <select @change=${this.onModelChange}>
              ${this.models.map(
                (m) => html`
                  <option
                    value="${m.provider}/${m.id}"
                    ?selected=${m.provider === this.currentProvider &&
                    m.id === this.currentModel}
                  >
                    ${m.label || `${m.provider}/${m.id}`}
                  </option>
                `,
              )}
              ${this.models.length === 0
                ? html`<option disabled selected>
                    ${this.currentProvider}/${this.currentModel || "loading..."}
                  </option>`
                : nothing}
            </select>
          </div>

          <div class="field">
            <label>Thinking Level</label>
            <div class="segmented">
              ${THINKING_LEVELS.map(
                (level) => html`
                  <button
                    class="seg-btn ${this.currentThinkingLevel === level
                      ? "active"
                      : ""}"
                    @click=${() => this.onThinkingChange(level)}
                  >
                    ${level}
                  </button>
                `,
              )}
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

  private onModelChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    const [provider, ...rest] = value.split("/");
    const model = rest.join("/");
    this.dispatchEvent(
      new CustomEvent("model-change", { detail: { provider, model } }),
    );
  }

  private onThinkingChange(level: ThinkingLevel) {
    this.dispatchEvent(
      new CustomEvent("thinking-change", { detail: level }),
    );
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
