import { html, nothing } from "lit";

type SidebarFilterMode = "default" | "no-tools" | "user-only" | "all";

type SidebarRole = "user" | "assistant" | "tool";

interface SidebarEntry {
  role: SidebarRole;
  text: string;
  targetId: string;
}

export interface ActiveSessionItem {
  id: string;
  name: string;
  attached: boolean;
  activeHere: boolean;
}

interface RenderChatSidebarOptions {
  search: string;
  filter: SidebarFilterMode;
  entries: SidebarEntry[];
  activeSessions: ActiveSessionItem[];
  onSearchInput: (event: InputEvent) => void;
  onSelectFilter: (mode: SidebarFilterMode) => void;
  onFocusMessage: (targetId: string) => void;
}

const SIDEBAR_FILTERS: Array<[SidebarFilterMode, string]> = [
  ["default", "Default"],
  ["no-tools", "No-tools"],
  ["user-only", "User"],
  ["all", "All"],
];

export function renderChatSidebar({
  search,
  filter,
  entries,
  activeSessions,
  onSearchInput,
  onSelectFilter,
  onFocusMessage,
}: RenderChatSidebarOptions) {
  return html`
    <aside class="cv-sidebar" aria-label="Message history">
      <div class="cv-sidebar-controls">
        <input
          class="cv-sidebar-search"
          placeholder="Search..."
          .value=${search}
          @input=${onSearchInput}
        />
        <div class="cv-sidebar-filters">
          ${SIDEBAR_FILTERS.map(
            ([mode, label]) => html`
              <button
                class="cv-filter-btn ${filter === mode ? "active" : ""}"
                @click=${() => onSelectFilter(mode)}
              >
                ${label}
              </button>
            `,
          )}
        </div>
      </div>

      <div class="cv-tree-container">
        ${entries.map(
          (entry) => html`
            <button
              class="cv-tree-node cv-tree-role-${entry.role}"
              @click=${() => onFocusMessage(entry.targetId)}
              title=${entry.text}
            >
              <span class="cv-tree-marker">•</span>
              <span class="cv-tree-role-label">${entry.role}:</span>
              <span class="cv-tree-text">${entry.text}</span>
            </button>
          `,
        )}
      </div>

      <div class="cv-tree-status">${entries.length} entries</div>

      ${activeSessions.length > 0
        ? html`
            <div class="cv-sidebar-sessions">
              <div class="cv-sidebar-sessions-header">Sessions</div>
              ${activeSessions.map(
                (s) => html`
                  <a class="cv-sidebar-session-item" href="#/session/${s.id}">
                    ${s.attached
                      ? html`<span class="cv-sidebar-session-dot active"></span>`
                      : s.activeHere
                        ? html`<span class="cv-sidebar-session-dot idle"></span>`
                        : nothing}
                    <span class="cv-sidebar-session-name">${s.name}</span>
                  </a>
                `,
              )}
            </div>
          `
        : nothing}
    </aside>
  `;
}
