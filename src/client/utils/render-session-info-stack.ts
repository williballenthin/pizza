import { html, nothing } from "lit";
import type { ToolSpec, SessionMessageStats } from "@shared/types.js";
import type { UsageTotals } from "./render-chat-editor-footer.js";

interface SessionInfoStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

interface RenderSessionInfoStackOptions {
  sessionId: string;
  sessionName: string;
  renamingName: boolean;
  editName: string;
  createdAtLabel: string;
  lastActivityAtLabel: string;
  modelLabel: string;
  thinkingLevel: string;
  stats: SessionInfoStats;
  persistedMessageStats: SessionMessageStats;
  pendingMessageCount: number;
  usage: UsageTotals;
  currentContextWindow: number | null;
  contextMessageCount: number;
  systemPrompt: string;
  knownTools: ToolSpec[];
  onStartRename: () => void;
  onEditNameInput: (e: InputEvent) => void;
  onTitleKeydown: (e: KeyboardEvent) => void;
  onCommitRename: () => void;
}

const PROMPT_PREVIEW_LINES = 10;

function formatCompactCount(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.max(0, value));
}

function formatHistoryRow(stats: SessionMessageStats, totalTokens: number): string {
  const tokens = totalTokens > 0 ? ` \u00b7 ${formatCompactCount(totalTokens)} tokens` : "";
  return `${stats.totalMessages} messages${tokens}`;
}

function formatContextRow(
  contextMessageCount: number,
  activeContextTokens: number | null,
  contextWindow: number | null,
): string {
  if (contextWindow && contextWindow > 0 && activeContextTokens !== null) {
    const pct = Math.min(100, Math.max(0, (activeContextTokens / contextWindow) * 100));
    return `${contextMessageCount} messages \u00b7 ${pct.toFixed(1)}% of ${formatCompactCount(contextWindow)}`;
  }
  return `${contextMessageCount} messages`;
}

export function renderSessionInfoStack({
  sessionId,
  sessionName,
  renamingName,
  editName,
  createdAtLabel,
  lastActivityAtLabel,
  modelLabel,
  thinkingLevel,
  stats,
  persistedMessageStats,
  pendingMessageCount,
  usage,
  currentContextWindow,
  contextMessageCount,
  systemPrompt,
  knownTools,
  onStartRename,
  onEditNameInput,
  onTitleKeydown,
  onCommitRename,
}: RenderSessionInfoStackOptions) {
  const trimmedSystemPrompt = systemPrompt.trim();
  const promptLines = trimmedSystemPrompt ? trimmedSystemPrompt.split("\n") : [];
  const promptPreview = promptLines.slice(0, PROMPT_PREVIEW_LINES).join("\n");
  const promptRemainder = Math.max(0, promptLines.length - PROMPT_PREVIEW_LINES);

  return html`
    <div class="cv-info-stack">
      <div class="cv-info-card cv-metadata-card">
        <div class="cv-info-title">Session metadata</div>
        <div class="cv-info-header">
          ${renamingName
            ? html`
                <div class="cv-title-row">
                  <input
                    class="cv-title-input cv-info-title-input"
                    .value=${editName}
                    @input=${onEditNameInput}
                    @keydown=${onTitleKeydown}
                    @blur=${onCommitRename}
                    autofocus
                  />
                </div>
              `
            : html`
                <div class="cv-title-row">
                  <div class="cv-title cv-info-title-name" @click=${onStartRename} title="Click to rename">
                    ${sessionName}
                  </div>
                </div>
              `}
        </div>
        <div class="cv-info-grid">
          <div class="cv-info-item"><span>Session</span><strong>${sessionId}</strong></div>
          <div class="cv-info-item"><span>Created</span><strong>${createdAtLabel}</strong></div>
          <div class="cv-info-item"><span>Last Activity</span><strong>${lastActivityAtLabel}</strong></div>
          <div class="cv-info-item"><span>Model</span><strong>${modelLabel}</strong></div>
          <div class="cv-info-item"><span>Thinking</span><strong>${thinkingLevel}</strong></div>
          <div class="cv-info-item">
            <span>Messages</span>
            <strong>${stats.userMessages} user &middot; ${stats.assistantMessages} assistant &middot; ${stats.toolCalls} tool calls</strong>
          </div>
          <div class="cv-info-item">
            <span>History</span>
            <strong>${formatHistoryRow(persistedMessageStats, usage.input + usage.output)}</strong>
          </div>
          <div class="cv-info-item">
            <span>Context</span>
            <strong>${formatContextRow(contextMessageCount, usage.activeContextTokens, currentContextWindow)}</strong>
          </div>
        </div>
      </div>

      ${trimmedSystemPrompt
        ? html`
            <details class="cv-info-card cv-system-prompt" ?open=${promptLines.length <= PROMPT_PREVIEW_LINES}>
              <summary class="cv-info-title">System prompt</summary>
              <div class="cv-system-prompt-body">
                <pre>${promptLines.length > PROMPT_PREVIEW_LINES ? promptPreview : trimmedSystemPrompt}</pre>
                ${promptRemainder > 0
                  ? html`
                      <div class="cv-system-prompt-hint">... (${promptRemainder} more lines)</div>
                      <pre class="cv-system-prompt-full">${trimmedSystemPrompt}</pre>
                    `
                  : nothing}
              </div>
            </details>
          `
        : nothing}

      <details class="cv-info-card cv-tools-card">
        <summary class="cv-info-title">Available tools (${knownTools.length})</summary>
        <div class="cv-tools-list">
          ${knownTools.map(
            (tool) => html`
              <details class="cv-tool-item">
                <summary>
                  <span class="cv-tool-name">${tool.name}</span>
                  <span class="cv-tool-desc">${tool.description || ""}</span>
                </summary>
                ${tool.parameters?.properties
                  ? html`
                      <div class="cv-tool-params">
                        ${Object.entries(tool.parameters.properties).map(
                          ([name, def]) => html`
                            <div class="cv-tool-param">
                              <span class="cv-tool-param-name">${name}</span>
                              <span class="cv-tool-param-type">${def?.type || "any"}</span>
                              <span class="cv-tool-param-req">
                                ${tool.parameters?.required?.includes(name)
                                  ? "required"
                                  : "optional"}
                              </span>
                              ${def?.description
                                ? html`<div class="cv-tool-param-desc">${def.description}</div>`
                                : nothing}
                            </div>
                          `,
                        )}
                      </div>
                    `
                  : html`
                      <div class="cv-tool-params cv-tool-params-empty">
                        No parameter schema available.
                      </div>
                    `}
              </details>
            `,
          )}
        </div>
      </details>
    </div>
  `;
}
