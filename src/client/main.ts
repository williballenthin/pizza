// Pi-web-ui CSS (Tailwind + mini-lit theme) — must load before components
import "@mariozechner/pi-web-ui/app.css";

// NOTE: We only import pi-web-ui CSS. The JS component bundle currently
// triggers Lit class-field shadowing errors in dev, so message rendering is
// implemented by local components.

// Our components
import "./components/app-root.js";
import "./components/session-list.js";
import "./components/message-list.js";
import "./components/chat-view.js";
import "./components/settings-panel.js";
import "./components/chat-input.js";

// ---- Theme initialization ----

function applyTheme(theme: string | null) {
  const html = document.documentElement;
  if (theme === "dark") {
    html.setAttribute("data-theme", "dark");
    html.classList.add("dark");
  } else if (theme === "light") {
    html.setAttribute("data-theme", "light");
    html.classList.remove("dark");
  } else {
    // Auto — follow system preference
    html.removeAttribute("data-theme");
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      html.classList.add("dark");
    } else {
      html.classList.remove("dark");
    }
  }
}

// Apply saved preference
const saved = localStorage.getItem("pi-theme");
applyTheme(saved);

// Listen for system preference changes (affects auto mode)
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    const current = localStorage.getItem("pi-theme");
    if (!current) applyTheme(null); // re-apply auto
  });

// Export for use by settings-panel
(window as unknown as Record<string, unknown>).__applyTheme = applyTheme;
