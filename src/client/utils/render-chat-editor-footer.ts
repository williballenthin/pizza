import { html, nothing } from "lit";
import type { ModelInfo, ThinkingLevel } from "@shared/types.js";
import type { ExtensionStatusEntry, ExtensionWidgetEntry } from "./extension-ui-state.js";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  activeContextTokens: number | null;
  totalCost: number;
}

interface RenderChatEditorFooterOptions {
  usage: UsageTotals;
  hostCwd: string;
  hostGitBranch: string;
  reconnecting: boolean;
  connected: boolean;
  isStreaming: boolean;
  currentContextWindow: number | null;
  autoCompactionEnabled: boolean;
  persistedMessageCount: number;
  pendingMessageCount: number;
  extensionStatuses: ExtensionStatusEntry[];
  extensionWidgets: ExtensionWidgetEntry[];
  models: ModelInfo[];
  currentProvider: string | null;
  currentModel: string | null;
  currentThinkingLevel: ThinkingLevel | "";
  thinkingLevels: ThinkingLevel[];
  onModelChange: (event: Event) => void;
  onThinkingChange: (event: Event) => void;
}

function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.max(0, value));
}

function formatWorkspacePath(path: string): string {
  if (!path) return "";
  let normalized = path
    .replace(/^([A-Za-z]:)?[\\/](Users|home)[\\/][^\\/]+/i, "~")
    .replace(/\\/g, "/");
  if (normalized.length > 90) {
    normalized = `…${normalized.slice(-89)}`;
  }
  return normalized;
}

function formatWorkspaceLabel(hostCwd: string, hostGitBranch: string): string {
  const cwd = formatWorkspacePath(hostCwd);
  if (cwd && hostGitBranch) {
    return `${cwd} (${hostGitBranch})`;
  }
  if (cwd) return cwd;
  if (hostGitBranch) return `(${hostGitBranch})`;
  return "";
}

function formatContextStatus(
  currentContextWindow: number | null,
  usage: UsageTotals,
  autoCompactionEnabled: boolean,
  persistedMessageCount: number,
  pendingMessageCount: number
): string {
  if (currentContextWindow && currentContextWindow > 0) {
    const activeTokens = usage.activeContextTokens ?? 0;
    const pct = (activeTokens / currentContextWindow) * 100;
    const boundedPct = Math.min(100, Math.max(0, pct));
    const ratio = `${boundedPct.toFixed(1)}%/${formatCompactCount(currentContextWindow)}`;
    const mode = autoCompactionEnabled ? " (auto)" : "";
    return `${ratio}${mode}`;
  }

  const pending =
    pendingMessageCount > 0 ? ` (+${pendingMessageCount} pending)` : "";
  return `${persistedMessageCount}${pending} msgs`;
}

function formatConnectionStatus(reconnecting: boolean, connected: boolean, isStreaming: boolean): string {
  if (reconnecting) return "reconnecting";
  if (!connected) return "offline";
  if (isStreaming) return "streaming";
  return "ready";
}

function extensionStatusBits(extensionStatuses: ExtensionStatusEntry[]): string[] {
  return extensionStatuses
    .map((status) => {
      const key = status.key?.trim();
      const text = status.text?.trim();
      if (!key && !text) return "";
      if (!key) return text;
      if (!text) return key;
      return `${key}: ${text}`;
    })
    .filter((entry): entry is string => !!entry);
}

function modelOptionLabel(model: ModelInfo): string {
  const identifier = `${model.provider}/${model.id}`;
  if (!model.label || model.label.trim() === "" || model.label === identifier) {
    return identifier;
  }
  return `${model.label} (${identifier})`;
}

function renderModelPicker(
  models: ModelInfo[],
  currentProvider: string | null,
  currentModel: string | null,
  onModelChange: (event: Event) => void
) {
  const selected = (currentProvider && currentModel) ? `${currentProvider}/${currentModel}` : "";
  const hasSelected = models.some(
    (model) =>
      model.provider === currentProvider && model.id === currentModel,
  );
  const showPlaceholder = !hasSelected && !selected;

  return html`
    <select
      class="cv-status-select cv-status-select-model"
      aria-label="Model"
      title="Model"
      .value=${selected}
      @change=${onModelChange}
      ?disabled=${models.length === 0}
    >
      ${showPlaceholder
        ? html`<option value="" selected></option>`
        : nothing}
      ${!hasSelected && selected
        ? html`<option value=${selected}>${currentProvider ? `(${currentProvider}) ` : ""}${currentModel}</option>`
        : nothing}
      ${models.map(
        (model) => html`
          <option value="${model.provider}/${model.id}">
            ${modelOptionLabel(model)}
          </option>
        `,
      )}
    </select>
  `;
}

function renderThinkingPicker(
  currentThinkingLevel: ThinkingLevel | "",
  thinkingLevels: ThinkingLevel[],
  onThinkingChange: (event: Event) => void
) {
  const hasValue = currentThinkingLevel && thinkingLevels.includes(currentThinkingLevel);

  return html`
    <select
      class="cv-status-select cv-status-select-thinking"
      aria-label="Thinking level"
      title="Thinking level"
      .value=${currentThinkingLevel}
      @change=${onThinkingChange}
    >
      ${!hasValue
        ? html`<option value="" selected></option>`
        : nothing}
      ${thinkingLevels.map(
        (level) => html`
          <option value=${level}>${level}</option>
        `,
      )}
    </select>
  `;
}

function renderEditorWidgets(extensionWidgets: ExtensionWidgetEntry[], placement: "aboveEditor" | "belowEditor") {
  const widgets = extensionWidgets.filter(
    (widget) => widget.placement === placement,
  );
  if (widgets.length === 0) return nothing;

  return html`
    <div class="cv-editor-widget-stack cv-editor-widget-${placement}">
      ${widgets.map(
        (widget) => html`
          <div class="cv-editor-widget" data-widget-key=${widget.key}>
            ${widget.lines.map(
              (line) => html`
                <pre class="cv-editor-widget-line">${line}</pre>
              `,
            )}
          </div>
        `,
      )}
    </div>
  `;
}

export function renderChatEditorFooter({
  usage,
  hostCwd,
  hostGitBranch,
  reconnecting,
  connected,
  isStreaming,
  currentContextWindow,
  autoCompactionEnabled,
  persistedMessageCount,
  pendingMessageCount,
  extensionStatuses,
  extensionWidgets,
  models,
  currentProvider,
  currentModel,
  currentThinkingLevel,
  thinkingLevels,
  onModelChange,
  onThinkingChange,
}: RenderChatEditorFooterOptions) {
  const workspace = formatWorkspaceLabel(hostCwd, hostGitBranch);
  const connectionStatus = formatConnectionStatus(reconnecting, connected, isStreaming);
  const statusParts = [
    `↑${formatCompactCount(usage.input)}`,
    `↓${formatCompactCount(usage.output)}`,
    `R${formatCompactCount(usage.cacheRead)}`,
    `$${usage.totalCost.toFixed(3)}`,
    formatContextStatus(
      currentContextWindow,
      usage,
      autoCompactionEnabled,
      persistedMessageCount,
      pendingMessageCount
    ),
    ...(connectionStatus === "ready" ? [] : [connectionStatus]),
    ...extensionStatusBits(extensionStatuses),
  ];

  const statusText = statusParts.join(" · ");

  return html`
    <div class="cv-editor-status" role="status" aria-live="polite">
      ${workspace
        ? html`
            <div class="cv-editor-status-row">
              <span class="cv-editor-status-workspace" title=${workspace}
                >${workspace}</span
              >
            </div>
          `
        : nothing}

      ${renderEditorWidgets(extensionWidgets, "belowEditor")}

      <div class="cv-editor-status-row">
        <span class="cv-editor-status-left" title=${statusText}
          >${statusText}</span
        >
        <div class="cv-editor-status-right">
          ${renderModelPicker(models, currentProvider, currentModel, onModelChange)}
          <span class="cv-editor-status-dot">•</span>
          ${renderThinkingPicker(currentThinkingLevel, thinkingLevels, onThinkingChange)}
        </div>
      </div>
    </div>
  `;
}

export function renderAboveEditorWidgets(extensionWidgets: ExtensionWidgetEntry[]) {
  return renderEditorWidgets(extensionWidgets, "aboveEditor");
}
