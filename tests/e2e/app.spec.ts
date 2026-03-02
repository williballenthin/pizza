import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { test, expect, type Page } from "@playwright/test";

const E2E_SESSIONS_ROOT = "/tmp/pi-web-e2e-sessions";
const E2E_CWD = process.cwd();

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const E2E_BUCKET_DIR = join(E2E_SESSIONS_ROOT, encodeCwd(E2E_CWD));

interface SessionMeta {
  id: string;
  name: string;
}

interface SeedSessionOptions {
  timestamp?: string;
  name?: string;
  messages?: Array<Record<string, unknown> & { timestamp?: string }>;
}

async function createSession(baseURL: string): Promise<string> {
  const res = await fetch(`${baseURL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: E2E_CWD }),
  });
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function deleteSession(baseURL: string, id: string): Promise<void> {
  await fetch(`${baseURL}/api/sessions/${id}`, { method: "DELETE" });
}

async function listSessions(baseURL: string): Promise<SessionMeta[]> {
  const res = await fetch(`${baseURL}/api/sessions`);
  const data = (await res.json()) as { sessions: SessionMeta[] };
  return data.sessions;
}

function makeSessionJsonl(id: string, opts: SeedSessionOptions = {}): string {
  const ts = opts.timestamp || new Date().toISOString();
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: ts,
      cwd: E2E_CWD,
    }),
  );

  let parentId: string | null = null;
  let entryIdx = 0;

  for (const message of opts.messages || []) {
    const entryId = `e${String(entryIdx++).padStart(7, "0")}`;
    const lineTimestamp = typeof message.timestamp === "string" ? message.timestamp : ts;

    lines.push(
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId,
        timestamp: lineTimestamp,
        message,
      }),
    );
    parentId = entryId;
  }

  if (opts.name) {
    const entryId = `e${String(entryIdx++).padStart(7, "0")}`;
    lines.push(
      JSON.stringify({
        type: "session_info",
        id: entryId,
        parentId,
        timestamp: ts,
        name: opts.name,
      }),
    );
  }

  return lines.join("\n") + "\n";
}

async function createSeededSession(opts: SeedSessionOptions = {}): Promise<string> {
  const id = randomUUID();
  const fileName = `${Date.now()}_${id}.jsonl`;
  await mkdir(E2E_BUCKET_DIR, { recursive: true });
  await writeFile(join(E2E_BUCKET_DIR, fileName), makeSessionJsonl(id, opts));
  return id;
}

async function openSession(page: Page, id: string): Promise<void> {
  await page.goto(`/#/session/${id}`);
  await expect(page.locator("chat-view")).toBeAttached();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.locator("chat-input textarea");
  await input.fill(text);
  await input.press("Enter");
}

async function renameSessionFromHeader(page: Page, name: string): Promise<void> {
  await page.locator("chat-view .cv-title").click();
  const input = page.locator("chat-view .cv-title-input");
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press("Enter");
}

async function openSessionContextMenu(page: Page, sessionName: string): Promise<void> {
  const sessionItem = page
    .locator("session-list .session-item")
    .filter({ hasText: sessionName })
    .first();

  await expect(sessionItem).toBeVisible();
  await sessionItem.locator(".session-menu-btn").click();
  await expect(page.locator("session-list .context-menu")).toBeVisible();
}

test.describe("Landing Page", () => {
  test("shows header and new button", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("session-list")).toBeAttached();
    await expect(page.locator("session-list h1")).toContainText("Pi Web UI");
    await expect(page.locator("session-list .new-btn")).toContainText("New");
  });

  test("shows cwd in session meta", async ({ page, baseURL }) => {
    const id = await createSession(baseURL!);
    await page.goto("/");
    const sessionItem = page.locator("session-list .session-item").first();
    await expect(sessionItem).toBeVisible({ timeout: 5000 });
    await deleteSession(baseURL!, id);
  });

  test("shows empty state when no sessions exist", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("session-list")).toBeAttached();
  });

  test("clicking + New opens project picker", async ({ page }) => {
    await page.goto("/");
    await page.locator("session-list .new-btn").click();

    await expect(page.locator("session-list .project-picker")).toBeVisible();
  });

  test("project picker Enter key creates a session and navigates to chat view", async ({
    page,
    baseURL,
  }) => {
    await page.goto("/");
    await page.locator("session-list .new-btn").click();
    await expect(page.locator("session-list .project-picker")).toBeVisible();

    const input = page.locator("session-list .project-cwd-input");
    await input.fill(E2E_CWD);
    await input.press("Enter");

    await expect(page).toHaveURL(/#\/session\//);
    await expect(page.locator("chat-view")).toBeAttached();

    const hash = new URL(page.url()).hash;
    const id = hash.replace("#/session/", "").split("?")[0];
    if (id) {
      await deleteSession(baseURL!, id);
    }
  });

  test("session list shows created sessions", async ({ page, baseURL }) => {
    const id = await createSession(baseURL!);

    await fetch(`${baseURL}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E Test Session" }),
    });

    await page.goto("/");
    await expect(
      page
        .locator("session-list .session-item")
        .filter({ hasText: "E2E Test Session" })
        .first(),
    ).toBeVisible();

    await deleteSession(baseURL!, id);
  });
});

test.describe("Chat View", () => {
  let sessionId: string;

  test.beforeEach(async ({ baseURL }) => {
    sessionId = await createSession(baseURL!);
  });

  test.afterEach(async ({ baseURL }) => {
    if (sessionId) {
      await deleteSession(baseURL!, sessionId);
    }
  });

  test("displays session name and controls", async ({ page }) => {
    await openSession(page, sessionId);
    await expect(page.locator("chat-view .cv-back-btn")).toBeVisible();
    await expect(page.locator("chat-view .cv-gear-btn")).toBeVisible();
  });

  test("applies server state session name before send", async ({ page }) => {
    let promptSent = false;

    await page.route(`**/api/sessions/${sessionId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: sessionId,
          name: "HTTP title",
          createdAt: new Date(0).toISOString(),
          lastActivityAt: new Date(0).toISOString(),
          messageStats: {
            totalMessages: 0,
            userMessages: 0,
            assistantMessages: 0,
            toolMessages: 0,
          },
          activity: { isWorking: false },
        }),
      });
    });

    await page.routeWebSocket(new RegExp(`/api/sessions/${sessionId}/ws`), (ws) => {
      const sendMockState = () => {
        ws.send(
          JSON.stringify({
            type: "state",
            model: {
              provider: "test",
              id: "mock-model",
            },
            thinkingLevel: "off",
            sessionName: "Server-provided title",
            isStreaming: false,
            messages: [],
            messageCount: 0,
            pendingMessageCount: 0,
            systemPrompt: "",
            tools: [],
          }),
        );
      };

      sendMockState();
      setTimeout(sendMockState, 120);
      setTimeout(sendMockState, 320);

      ws.onMessage((rawMessage) => {
        const parsed = JSON.parse(rawMessage.toString()) as {
          type?: string;
        };

        if (parsed.type === "get_available_models") {
          ws.send(
            JSON.stringify({
              type: "available_models",
              models: [
                {
                  provider: "test",
                  id: "mock-model",
                  label: "Mock Model",
                },
              ],
            }),
          );
          return;
        }

        if (parsed.type === "get_commands") {
          ws.send(JSON.stringify({ type: "available_commands", commands: [] }));
          return;
        }

        if (parsed.type === "prompt") {
          promptSent = true;
        }
      });
    });

    await openSession(page, sessionId);
    await expect(page.locator("chat-view .cv-title")).toContainText(
      "Server-provided title",
    );

    await sendMessage(page, "hello from e2e");
    await expect.poll(() => promptSent, { timeout: 4000 }).toBe(true);
  });

  test("keeps fetched session name when WS state omits sessionName", async ({
    page,
  }) => {
    await page.route(`**/api/sessions/${sessionId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: sessionId,
          name: "HTTP title",
          createdAt: new Date(0).toISOString(),
          lastActivityAt: new Date(0).toISOString(),
          messageStats: {
            totalMessages: 0,
            userMessages: 0,
            assistantMessages: 0,
            toolMessages: 0,
          },
          activity: { isWorking: false },
        }),
      });
    });

    await page.routeWebSocket(new RegExp(`/api/sessions/${sessionId}/ws`), (ws) => {
      const sendMockState = () => {
        ws.send(
          JSON.stringify({
            type: "state",
            model: {
              provider: "test",
              id: "mock-model",
            },
            thinkingLevel: "off",
            isStreaming: false,
            messages: [],
            messageCount: 0,
            pendingMessageCount: 0,
            systemPrompt: "",
            tools: [],
          }),
        );
      };

      sendMockState();
      setTimeout(sendMockState, 120);
      setTimeout(sendMockState, 320);

      ws.onMessage((rawMessage) => {
        const parsed = JSON.parse(rawMessage.toString()) as {
          type?: string;
        };

        if (parsed.type === "get_available_models") {
          ws.send(
            JSON.stringify({
              type: "available_models",
              models: [
                {
                  provider: "test",
                  id: "mock-model",
                  label: "Mock Model",
                },
              ],
            }),
          );
          return;
        }

        if (parsed.type === "get_commands") {
          ws.send(JSON.stringify({ type: "available_commands", commands: [] }));
        }
      });
    });

    await openSession(page, sessionId);
    const title = page.locator("chat-view .cv-title");
    await expect(title).toContainText("HTTP title");
    await page.waitForTimeout(500);
    await expect(title).toContainText("HTTP title");
  });

  test("has a text input and send button", async ({ page }) => {
    await openSession(page, sessionId);
    await expect(page.locator("chat-input textarea")).toBeVisible();
    await expect(page.locator("chat-input .send-btn.send")).toBeAttached();
  });

  test("restores per-session draft text after reload", async ({ page }) => {
    await openSession(page, sessionId);

    const input = page.locator("chat-input textarea");
    await input.fill("draft should survive reload");
    await page.reload();

    await expect(page.locator("chat-view")).toBeAttached();
    await expect(page.locator("chat-input textarea")).toHaveValue(
      "draft should survive reload",
    );
  });

  test("shows cached read-only conversation until live state arrives", async ({
    page,
  }) => {
    await page.addInitScript(
      ({ id }) => {
        localStorage.setItem(
          `pi-chat-cache:${id}`,
          JSON.stringify({
            version: 1,
            savedAt: Date.now(),
            messages: [
              {
                role: "user",
                content: "cached startup message",
                timestamp: Date.now(),
              },
            ],
          }),
        );
      },
      { id: sessionId },
    );

    await page.routeWebSocket(new RegExp(`/api/sessions/${sessionId}/ws`), (ws) => {
      ws.onMessage((rawMessage) => {
        const parsed = JSON.parse(rawMessage.toString()) as {
          type?: string;
        };

        if (parsed.type === "get_available_models") {
          ws.send(JSON.stringify({ type: "available_models", models: [] }));
          return;
        }

        if (parsed.type === "get_commands") {
          ws.send(JSON.stringify({ type: "available_commands", commands: [] }));
          return;
        }

        if (parsed.type === "get_state") {
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "state",
                model: null,
                thinkingLevel: "off",
                isStreaming: false,
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "live synced message" }],
                    timestamp: Date.now(),
                  },
                ],
                pendingMessageCount: 0,
                systemPrompt: "",
                tools: [],
              }),
            );
          }, 350);
        }
      });
    });

    await openSession(page, sessionId);

    await expect(page.locator("chat-view .cv-cached-banner")).toBeVisible();
    await expect(page.locator("message-list")).toContainText("cached startup message");
    await expect(page.locator("chat-input textarea")).toBeDisabled();

    await expect(page.locator("chat-view .cv-cached-banner")).toBeHidden({
      timeout: 5000,
    });
    await expect(page.locator("message-list")).toContainText("live synced message");
    await expect(page.locator("chat-input textarea")).toBeEnabled();
  });

  test("send button is disabled when input is empty", async ({ page }) => {
    await openSession(page, sessionId);
    await expect(page.locator("chat-input .send-btn.send")).toBeDisabled();
  });

  test("back button navigates to landing page", async ({ page }) => {
    await openSession(page, sessionId);
    await page.locator("chat-view .cv-back-btn").click();
    await expect(page.locator("session-list")).toBeAttached();
  });

  test("renders user and assistant messages in message-list", async ({
    page,
    baseURL,
  }) => {
    const seededId = await createSeededSession({
      messages: [
        { role: "user", content: "hello", timestamp: new Date().toISOString() },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
          timestamp: new Date().toISOString(),
        },
      ],
    });

    try {
      await openSession(page, seededId);

      const list = page.locator("message-list");
      await expect(list.locator(".ml-user")).toHaveCount(1);
      await expect(list.locator(".ml-assistant")).toHaveCount(1);
      await expect(list).toContainText("hello");
      await expect(list).toContainText("hi there");
    } finally {
      await deleteSession(baseURL!, seededId);
    }
  });

  test("renders markdown formatting in assistant message", async ({
    page,
    baseURL,
  }) => {
    const seededId = await createSeededSession({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "**bold**\n\n```js\nconsole.log('ok')\n```",
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });

    try {
      await openSession(page, seededId);
      await expect(page.locator("message-list .markdown-content strong")).toBeVisible();
      await expect(page.locator("message-list .markdown-content pre code")).toBeVisible();
      await expect(page.locator("message-list")).toContainText("bold");
      await expect(page.locator("message-list")).toContainText("console.log");
    } finally {
      await deleteSession(baseURL!, seededId);
    }
  });

  test("renders bash execution rows", async ({ page }) => {
    await openSession(page, sessionId);

    await sendMessage(page, "!! echo hello");

    const shellRow = page.locator("message-list .bash-execution").first();
    await expect(shellRow).toBeVisible();
    await expect(shellRow).toContainText("echo hello");
    await expect(shellRow).toContainText("hello");
    await expect(shellRow).toContainText("not in context");
  });

  test("shows slash command suggestions from discovered commands", async ({ page }) => {
    await openSession(page, sessionId);

    await page.locator("chat-input textarea").fill("/");

    await expect
      .poll(async () => page.locator("chat-input .command-item").count(), {
        timeout: 5000,
      })
      .toBeGreaterThan(0);

    const inputBox = await page.locator("chat-input textarea").boundingBox();
    const popoverBox = await page.locator("chat-input .commands-popover").boundingBox();

    expect(inputBox).not.toBeNull();
    expect(popoverBox).not.toBeNull();
    expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(inputBox!.y + 2);
  });

  test("renders extension confirm request and sends response", async ({ page }) => {
    let capturedResponse: Record<string, unknown> | null = null;
    let sentInitialEvents = false;

    await page.routeWebSocket(new RegExp(`/api/sessions/${sessionId}/ws`), (ws) => {
      if (!sentInitialEvents) {
        sentInitialEvents = true;

        ws.send(
          JSON.stringify({
            type: "state",
            model: null,
            thinkingLevel: "off",
            sessionName: "Confirm Session",
            isStreaming: false,
            messages: [],
            messageCount: 0,
            pendingMessageCount: 0,
            systemPrompt: "",
            tools: [],
          }),
        );

        ws.send(
          JSON.stringify({
            type: "agent_event",
            event: {
              type: "extension_ui_request",
              id: "ext-1",
              method: "confirm",
              title: "Extension confirmation",
              message: "Proceed with operation?",
            },
          }),
        );
      }

      ws.onMessage((rawMessage) => {
        const parsed = JSON.parse(rawMessage.toString()) as {
          type?: string;
          [key: string]: unknown;
        };

        if (parsed.type === "get_available_models") {
          ws.send(JSON.stringify({ type: "available_models", models: [] }));
          return;
        }

        if (parsed.type === "get_commands") {
          ws.send(JSON.stringify({ type: "available_commands", commands: [] }));
          return;
        }

        if (parsed.type === "extension_ui_response") {
          capturedResponse = parsed as Record<string, unknown>;
        }
      });
    });

    await openSession(page, sessionId);

    const modal = page.locator("chat-view .cv-extension-modal");
    await expect(modal).toContainText("Extension confirmation");
    await expect(modal).toContainText("Proceed with operation?");

    await page
      .locator("chat-view .cv-extension-btn.primary")
      .filter({ hasText: "Yes" })
      .click();

    await expect
      .poll(() => capturedResponse, { timeout: 4000 })
      .toEqual({
        type: "extension_ui_response",
        id: "ext-1",
        confirmed: true,
      });
  });

  test("renders extension notify requests inline in message list", async ({
    page,
    baseURL,
  }) => {
    const seededId = await createSeededSession({
      messages: [
        {
          role: "custom",
          customType: "notify",
          content: "Compaction started",
          details: { notifyType: "warning" },
          display: true,
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await openSession(page, seededId);
      const custom = page.locator("message-list .custom-message").first();
      await expect(custom).toBeVisible();
      await expect(custom).toContainText("Compaction started");
    } finally {
      await deleteSession(baseURL!, seededId);
    }
  });

  test("shows auto compaction events inline", async ({ page, baseURL }) => {
    const seededId = await createSeededSession({
      messages: [
        {
          role: "custom",
          customType: "notify",
          content: "Context overflow detected. Auto-compacting context…",
          details: { notifyType: "warning" },
          display: true,
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await openSession(page, seededId);
      const custom = page.locator("message-list .custom-message").first();
      await expect(custom).toBeVisible();
      await expect(custom).toContainText("Auto-compacting context");
    } finally {
      await deleteSession(baseURL!, seededId);
    }
  });

  test("renders compaction summary messages", async ({ page, baseURL }) => {
    const seededId = await createSeededSession({
      messages: [
        {
          role: "compactionSummary",
          summary: "Older context condensed into summary text.",
          tokensBefore: 23456,
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await openSession(page, seededId);
      const details = page.locator("message-list .compaction").first();
      await expect(details).toBeVisible();
      await expect(details).toContainText("Compacted from 23,456 tokens");
      await expect(details).toContainText("Older context condensed into summary text.");
    } finally {
      await deleteSession(baseURL!, seededId);
    }
  });

  test("tool calls are collapsible and show output when expanded", async ({
    page,
    baseURL,
  }) => {
    const seededId = await createSeededSession({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "read",
              arguments: { path: "src/client/main.ts", offset: 1, limit: 2 },
            },
          ],
          timestamp: new Date().toISOString(),
        },
        {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "read",
          output: "line one\nline two",
          timestamp: Date.now(),
          isError: false,
        },
      ],
    });

    try {
      await openSession(page, seededId);
      const details = page.locator("message-list .tool-call-details").first();
      await expect(details).toBeVisible();
      await expect(details).toHaveJSProperty("open", false);

      await details.locator(".tool-call-summary").click();

      await expect(details).toHaveJSProperty("open", true);
      await expect(details.locator(".tool-call-body")).toContainText("line one");
    } finally {
      await deleteSession(baseURL!, seededId);
    }
  });

  test("renders metadata, system prompt, and tools cards", async ({
    page,
    baseURL,
  }) => {
    const seededId = await createSeededSession({
      messages: [
        {
          role: "system",
          content: "You are a test prompt.\nKeep output concise.",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    try {
      await openSession(page, seededId);

      const metadataCard = page.locator("chat-view .cv-info-card").first();
      await expect(metadataCard.locator(".cv-info-title")).toContainText(
        "Session metadata",
      );
      await expect(metadataCard).not.toContainText("Steering Queue");
      await expect(metadataCard).not.toContainText("Follow-up Queue");
      await expect(metadataCard).not.toContainText("Slash Commands");

      await expect(page.locator("chat-view .cv-system-prompt")).toContainText(
        "You are a test prompt.",
      );
      await expect(page.locator("chat-view .cv-tools-card")).toBeVisible();
    } finally {
      await deleteSession(baseURL!, seededId);
    }
  });

  test("shows model/context/status below chat input", async ({ page }) => {
    await openSession(page, sessionId);

    const status = page.locator("chat-view .cv-editor-status");
    await expect(status).toBeVisible();
    await expect(status).not.toHaveText(/^\s*$/);
    await expect(status).toContainText("↑");
    await expect(status).toContainText("↓");
    await expect(status).toContainText(/(\d+(\.\d+)?%\/|msgs)/);
    await expect(status.locator(".cv-status-select-model")).toBeVisible();
    await expect(status.locator(".cv-status-select-thinking")).toBeVisible();

    const inputBox = await page.locator("chat-view chat-input").boundingBox();
    const statusBox = await status.boundingBox();
    if (!inputBox || !statusBox) {
      throw new Error("Expected chat input and status bar to be visible");
    }
    expect(statusBox.y).toBeGreaterThan(inputBox.y + inputBox.height - 1);
  });

  test("lets you pick thinking level from the footer controls", async ({ page }) => {
    await openSession(page, sessionId);

    const thinkingSelect = page.locator("chat-view .cv-status-select-thinking");
    await expect(thinkingSelect).toBeVisible();
    await thinkingSelect.selectOption("high");
    await expect(thinkingSelect).toHaveValue("high");
  });

  test("supports deep-link target without per-message link buttons", async ({
    page,
    baseURL,
  }) => {
    const seededId = await createSeededSession({
      messages: [
        {
          role: "user",
          id: "m1",
          content: "first",
          timestamp: new Date(Date.now() - 1000).toISOString(),
        },
        {
          role: "assistant",
          id: "m2",
          content: [{ type: "text", text: "second" }],
          timestamp: new Date().toISOString(),
        },
      ],
    });

    try {
      await page.goto(`/#/session/${seededId}?target=msg-m2`);
      await expect(page.locator("chat-view")).toBeAttached();
      await expect(page.locator("chat-view #msg-m2")).toBeVisible();
      await expect(page.locator("chat-view .copy-link-btn")).toHaveCount(0);
    } finally {
      await deleteSession(baseURL!, seededId);
    }
  });
});

test.describe("Settings Panel", () => {
  let sessionId: string;

  test.beforeEach(async ({ baseURL }) => {
    sessionId = await createSession(baseURL!);
  });

  test.afterEach(async ({ baseURL }) => {
    if (sessionId) {
      await deleteSession(baseURL!, sessionId);
    }
  });

  test("opens when gear icon is clicked", async ({ page }) => {
    await openSession(page, sessionId);
    await page.locator("chat-view .cv-gear-btn").click();
    await expect(page.locator("settings-panel .panel.open")).toBeVisible();
  });

  test("shows theme toggle", async ({ page }) => {
    await openSession(page, sessionId);
    await page.locator("chat-view .cv-gear-btn").click();

    await expect(page.locator("settings-panel .theme-btn").filter({ hasText: "Auto" })).toBeVisible();
    await expect(page.locator("settings-panel .theme-btn").filter({ hasText: "Light" })).toBeVisible();
    await expect(page.locator("settings-panel .theme-btn").filter({ hasText: "Dark" })).toBeVisible();
  });

  test("keeps model/thinking controls out of settings panel", async ({ page }) => {
    await openSession(page, sessionId);
    await page.locator("chat-view .cv-gear-btn").click();

    const settingsPanel = page.locator("settings-panel");
    await expect(settingsPanel).toContainText("Steering Queue");
    await expect(settingsPanel).toContainText("Follow-up Queue");
    await expect(settingsPanel).not.toContainText("Model");
    await expect(settingsPanel).not.toContainText("Thinking Level");
  });
});

test.describe("Responsive Layout", () => {
  let sessionId: string;

  test.beforeEach(async ({ baseURL }) => {
    sessionId = await createSession(baseURL!);
  });

  test.afterEach(async ({ baseURL }) => {
    if (sessionId) {
      await deleteSession(baseURL!, sessionId);
    }
  });

  test("landing page renders correctly", async ({ page }) => {
    await page.goto("/");
    const screenshot = await page.screenshot();
    expect(screenshot).toBeTruthy();
    await expect(page.locator("app-root")).toBeAttached();
  });

  test("chat view renders correctly", async ({ page }) => {
    await openSession(page, sessionId);
    const screenshot = await page.screenshot();
    expect(screenshot).toBeTruthy();
  });
});

test.describe("Session Not Found", () => {
  test("shows 404 page for non-existent session", async ({ page }) => {
    await page.goto("/#/session/nonexistent_session_id_12345");

    await expect(page.locator(".not-found")).toBeAttached({ timeout: 5000 });
    await expect(page.locator(".not-found")).toContainText("Session not found");
    await expect(page.locator(".not-found")).toContainText(
      "nonexistent_session_id_12345",
    );
  });
});

test.describe("Session Rename", () => {
  let sessionId: string;

  test.beforeEach(async ({ baseURL }) => {
    sessionId = await createSession(baseURL!);
  });

  test.afterEach(async ({ baseURL }) => {
    if (sessionId) {
      await deleteSession(baseURL!, sessionId);
    }
  });

  test("can rename session from chat view header", async ({
    page,
    baseURL,
  }) => {
    await openSession(page, sessionId);
    await renameSessionFromHeader(page, "Renamed via E2E");

    await expect
      .poll(
        async () => {
          const sessions = await listSessions(baseURL!);
          return sessions.find((s) => s.id === sessionId)?.name || "";
        },
        { timeout: 4000, message: "Session rename should persist" },
      )
      .toBe("Renamed via E2E");
  });
});

test.describe("Session Archive", () => {
  test("can archive a session from session list context menu", async ({
    page,
    baseURL,
  }) => {
    const id = await createSession(baseURL!);
    const name = `Archive Me ${id.slice(0, 8)}`;

    await fetch(`${baseURL}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    await page.goto("/");
    await openSessionContextMenu(page, name);
    await page
      .locator("session-list .context-menu button")
      .filter({ hasText: "Archive" })
      .click();

    await expect
      .poll(
        async () => {
          const sessions = await listSessions(baseURL!);
          const session = sessions.find((s) => s.id === id);
          return session?.name || "";
        },
        { timeout: 4000, message: "Session should be archived" },
      )
      .toContain("archived: ");

    await expect(
      page
        .locator("session-list .session-item.archived")
        .filter({ hasText: name })
        .first(),
    ).toBeVisible();

    await deleteSession(baseURL!, id);
  });

  test("sending a message unarchives archived session names", async ({
    page,
    baseURL,
  }) => {
    const id = await createSession(baseURL!);

    await fetch(`${baseURL}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "archived: Resume Later" }),
    });

    await openSession(page, id);
    await expect(page.locator("chat-view .cv-title")).toContainText(
      "archived: Resume Later",
    );

    await sendMessage(page, "hello again");

    await expect
      .poll(
        async () => {
          const sessions = await listSessions(baseURL!);
          const session = sessions.find((s) => s.id === id);
          return session?.name || "";
        },
        { timeout: 4000, message: "Session should auto-unarchive on send" },
      )
      .toBe("Resume Later");

    await deleteSession(baseURL!, id);
  });
});

test.describe("Session Delete from Landing Page", () => {
  test("can delete a session via context menu", async ({ page, baseURL }) => {
    const id = await createSession(baseURL!);
    const name = `To Delete ${id.slice(0, 8)}`;

    await fetch(`${baseURL}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    await page.goto("/");
    await openSessionContextMenu(page, name);

    page.once("dialog", (dialog) => dialog.accept());

    await page.locator("session-list .context-menu .danger").click();

    await expect
      .poll(
        async () => {
          const sessions = await listSessions(baseURL!);
          return sessions.some((s) => s.id === id);
        },
        { timeout: 4000, message: "Session should be deleted" },
      )
      .toBe(false);
  });
});

test.describe("Sidebar Active Sessions", () => {
  test("shows other active sessions in sidebar on desktop", async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "Sidebar hidden on mobile");
    const id1 = await createSession(baseURL!);
    const id2 = await createSession(baseURL!);

    await fetch(`${baseURL}/api/sessions/${id1}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Session Alpha" }),
    });
    await fetch(`${baseURL}/api/sessions/${id2}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Session Beta" }),
    });

    try {
      await openSession(page, id2);
      await expect(page.locator("chat-view")).toBeAttached();

      await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, id1);
      await expect(page.locator("chat-view .cv-title")).not.toContainText("Session Beta", { timeout: 3000 });

      const sessionLink = page.locator(".cv-sidebar-session-item").filter({
        hasText: "Session Beta",
      });
      await expect(sessionLink).toBeVisible({ timeout: 10000 });

      await sessionLink.click();
      await expect(page).toHaveURL(new RegExp(`#/session/${id2}`));
    } finally {
      await deleteSession(baseURL!, id1);
      await deleteSession(baseURL!, id2);
    }
  });
});
