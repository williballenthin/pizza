import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  fetchSessionInfoResult,
  type SessionInfo,
} from "../utils/session-actions.js";

type Route =
  | { page: "loading" }
  | { page: "home" }
  | { page: "session"; id: string; info: SessionInfo | null; targetId?: string }
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
  @state() private route: Route = { page: "loading" };

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
      case "loading":
      case "home":
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
    if (!sessionMatch) {
      this.route = { page: "home" };
      return;
    }

    const id = decodeURIComponent(sessionMatch[1]);
    const query = new URLSearchParams(sessionMatch[2] || "");
    const targetId = query.get("target") || undefined;

    this.route = { page: "loading" };
    const result = await fetchSessionInfoResult(id);
    this.route = result.status === "not-found"
      ? { page: "not-found", id }
      : { page: "session", id, info: result.info, targetId };
  };

  render() {
    switch (this.route.page) {
      case "session":
        return html`<chat-view
          .sessionId=${this.route.id}
          .initialSessionInfo=${this.route.info}
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
      case "loading":
        return html``;
      default:
        return html`<session-list></session-list>`;
    }
  }
}
