import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";

type Route =
  | { page: "home" }
  | { page: "session"; id: string; targetId?: string }
  | { page: "not-found"; id: string };

/**
 * Root application shell with simple hash-based routing.
 *
 * Routes:
 *   #/           → session list (landing page)
 *   #/session/X  → chat view for session X (validates session exists)
 */
@customElement("app-root")
export class AppRoot extends LitElement {
  @state() private route: Route = { page: "home" };

  override createRenderRoot() {
    return this;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("hashchange", this.onHashChange);
    this.onHashChange();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.onHashChange);
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("route")) {
      this.updateDocumentTitle();
    }
  }

  private updateDocumentTitle() {
    switch (this.route.page) {
      case "home":
        document.title = "pizza";
        break;
      case "not-found":
        document.title = "pizza";
        break;
      case "session":
        // Placeholder until chat-view loads the real session name.
        document.title = "pizza";
        break;
    }
  }

  private onHashChange = async () => {
    const hash = window.location.hash || "#/";
    const sessionMatch = hash.match(/^#\/session\/([^?]+)(?:\?(.*))?$/);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]);
      const query = new URLSearchParams(sessionMatch[2] || "");
      const targetId = query.get("target") || undefined;

      // Validate session exists
      const exists = await this.sessionExists(id);
      if (exists) {
        this.route = { page: "session", id, targetId };
      } else {
        this.route = { page: "not-found", id };
      }
    } else {
      this.route = { page: "home" };
    }
  };

  private async sessionExists(id: string): Promise<boolean> {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return true; // assume exists on API error
      const data = await res.json();
      return data.sessions.some((s: { id: string }) => s.id === id);
    } catch {
      return true; // assume exists on network error
    }
  }

  render() {
    switch (this.route.page) {
      case "session":
        return html`<chat-view
          .sessionId=${this.route.id}
          .targetMessageId=${this.route.targetId || ""}
        ></chat-view>`;
      case "not-found":
        return html`
          <div class="not-found">
            <h2>Session not found</h2>
            <p>The session <code>${this.route.id}</code> does not exist.</p>
            <a href="#/">Back to sessions</a>
          </div>
        `;
      default:
        return html`<session-list></session-list>`;
    }
  }
}
