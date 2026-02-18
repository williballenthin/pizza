import hljs from "highlight.js";
import { marked } from "marked";

let markedConfigured = false;

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeHtmlTags(text: string): string {
  return text.replace(/<(?=[a-zA-Z/])/g, "&lt;");
}

function configureMarked() {
  if (markedConfigured) return;

  marked.use({
    breaks: true,
    gfm: true,
    renderer: {
      code(token: { text: string; lang?: string }) {
        const code = token.text || "";
        const lang = token.lang;
        let highlighted: string;
        if (lang && hljs.getLanguage(lang)) {
          try {
            highlighted = hljs.highlight(code, { language: lang }).value;
          } catch {
            highlighted = escapeHtml(code);
          }
        } else {
          try {
            highlighted = hljs.highlightAuto(code).value;
          } catch {
            highlighted = escapeHtml(code);
          }
        }
        return `<pre><code class="hljs">${highlighted}</code></pre>`;
      },
      text(token: { text: string }) {
        return escapeHtmlTags(escapeHtml(token.text || ""));
      },
      codespan(token: { text: string }) {
        return `<code>${escapeHtml(token.text || "")}</code>`;
      },
      link(token: { href: string; title?: string | null; text: string }) {
        const href = escapeHtml(token.href || "");
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<a href="${href}" target="_blank" rel="noopener noreferrer"${title}>${token.text || ""}</a>`;
      },
    },
  });

  markedConfigured = true;
}

export function safeMarkedParse(text: string): string {
  configureMarked();
  const rendered = marked.parse(text || "");
  return typeof rendered === "string" ? rendered : "";
}

export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

export function shortenPath(p: string): string {
  if (p.startsWith("/Users/")) {
    const parts = p.split("/");
    if (parts.length > 2) return "~" + p.slice(("/Users/" + parts[2]).length);
  }
  if (p.startsWith("/home/")) {
    const parts = p.split("/");
    if (parts.length > 2) return "~" + p.slice(("/home/" + parts[2]).length);
  }
  return p;
}

export function getLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const extToLang: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    md: "markdown",
    dockerfile: "dockerfile",
  };
  return extToLang[ext];
}

export function formatExpandableOutput(
  text: string,
  maxLines: number,
  lang?: string,
): string {
  const normalized = replaceTabs(text || "");
  const lines = normalized.split("\n");
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  if (lang) {
    let highlighted = "";
    try {
      highlighted = hljs.highlight(normalized, {
        language: lang,
      }).value;
    } catch {
      highlighted = escapeHtml(normalized);
    }

    if (remaining > 0) {
      const previewCode = displayLines.join("\n");
      let previewHighlighted = "";
      try {
        previewHighlighted = hljs.highlight(previewCode, {
          language: lang,
        }).value;
      } catch {
        previewHighlighted = escapeHtml(previewCode);
      }

      return `<div class="tool-output expandable" onclick="this.classList.toggle('expanded')">
        <div class="output-preview"><pre><code class="hljs">${previewHighlighted}</code></pre>
        <div class="expand-hint">... (${remaining} more lines)</div></div>
        <div class="output-full"><pre><code class="hljs">${highlighted}</code></pre></div></div>`;
    }

    return `<div class="tool-output"><pre><code class="hljs">${highlighted}</code></pre></div>`;
  }

  if (remaining > 0) {
    let out =
      '<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
    out += '<div class="output-preview">';
    for (const line of displayLines) {
      out += `<div>${escapeHtml(line)}</div>`;
    }
    out += `<div class="expand-hint">... (${remaining} more lines)</div></div>`;
    out += '<div class="output-full">';
    for (const line of lines) {
      out += `<div>${escapeHtml(line)}</div>`;
    }
    out += "</div></div>";
    return out;
  }

  let out = '<div class="tool-output">';
  for (const line of displayLines) {
    out += `<div>${escapeHtml(line)}</div>`;
  }
  out += "</div>";
  return out;
}

export function formatTimestamp(ts: unknown): string {
  if (typeof ts !== "number" && typeof ts !== "string") return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
