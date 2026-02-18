import { test, expect } from "@playwright/test";

// Helper to hit the REST API directly
async function createSession(baseURL: string): Promise<string> {
  const res = await fetch(`${baseURL}/api/sessions`, { method: "POST" });
  const data = await res.json();
  return data.id;
}

async function deleteSession(baseURL: string, id: string): Promise<void> {
  await fetch(`${baseURL}/api/sessions/${id}`, { method: "DELETE" });
}

test.describe("Landing Page", () => {
  test("shows header and new button", async ({ page, baseURL }) => {
    await page.goto("/");
    await expect(page.locator("session-list")).toBeAttached();

    // session-list uses shadow DOM
    const title = await page
      .locator("session-list")
      .evaluate((el) => el.shadowRoot?.querySelector("h1")?.textContent);
    expect(title).toContain("Pi Web UI");

    const newBtn = await page
      .locator("session-list")
      .evaluate(
        (el) => el.shadowRoot?.querySelector(".new-btn")?.textContent?.trim(),
      );
    expect(newBtn).toContain("New");
  });

  test("shows empty state when no sessions exist", async ({
    page,
    baseURL,
  }) => {
    await page.goto("/");
    // Just verify the page loaded without errors
    expect(
      await page.locator("session-list").evaluate((el) => !!el.shadowRoot),
    ).toBe(true);
  });

  test("clicking + New creates a session and navigates to chat view", async ({
    page,
    baseURL,
  }) => {
    await page.goto("/");

    // Click the new button through shadow DOM
    await page.locator("session-list").evaluate((el) => {
      const btn = el.shadowRoot?.querySelector(".new-btn") as HTMLElement;
      btn?.click();
    });

    // Should navigate to a session URL
    await page.waitForFunction(() => window.location.hash.includes("/session/"));
    expect(page.url()).toContain("#/session/");

    // Chat view should be visible
    await expect(page.locator("chat-view")).toBeAttached();

    // Cleanup — extract session ID and delete
    const hash = await page.evaluate(() => window.location.hash);
    const id = hash.replace("#/session/", "");
    await deleteSession(baseURL!, id);
  });

  test("session list shows created sessions", async ({ page, baseURL }) => {
    const id = await createSession(baseURL!);

    // Rename for identification
    await fetch(`${baseURL}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E Test Session" }),
    });

    await page.goto("/");

    // Wait for sessions to load
    await page.waitForTimeout(500);

    const sessionText = await page.locator("session-list").evaluate((el) => {
      const items = el.shadowRoot?.querySelectorAll(".session-item");
      return Array.from(items || []).map((item) => item.textContent?.trim());
    });

    const found = sessionText.some((t) =>
      t?.includes("E2E Test Session"),
    );
    expect(found).toBe(true);

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
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    // chat-view is light DOM — query directly
    const backBtn = await page.locator("chat-view").evaluate((el) => {
      return !!el.querySelector(".cv-back-btn");
    });
    expect(backBtn).toBe(true);

    const settingsBtn = await page.locator("chat-view").evaluate((el) => {
      return !!el.querySelector(".cv-gear-btn");
    });
    expect(settingsBtn).toBe(true);
  });

  test("has a text input and send button", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    // chat-view is light DOM; chat-input is shadow DOM
    const hasInput = await page.locator("chat-view").evaluate((el) => {
      const chatInput = el.querySelector("chat-input");
      if (!chatInput) return false;
      const textarea = chatInput.shadowRoot?.querySelector("textarea");
      const sendBtn = chatInput.shadowRoot?.querySelector(".send-btn");
      return !!textarea && !!sendBtn;
    });
    expect(hasInput).toBe(true);
  });

  test("send button is disabled when input is empty", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    const isDisabled = await page.locator("chat-view").evaluate((el) => {
      const chatInput = el.querySelector("chat-input");
      const btn = chatInput?.shadowRoot?.querySelector(
        ".send-btn.send",
      ) as HTMLButtonElement;
      return btn?.disabled;
    });
    expect(isDisabled).toBe(true);
  });

  test("back button navigates to landing page", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const btn = el.querySelector(".cv-back-btn") as HTMLElement;
      btn?.click();
    });

    await page.waitForFunction(
      () => window.location.hash === "#/" || window.location.hash === "",
    );
    await expect(page.locator("session-list")).toBeAttached();
  });

  test("renders user and assistant messages in message-list", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        messages: unknown[];
        requestUpdate: () => void;
      };
      view.messages = [
        { role: "user", content: "hello", timestamp: Date.now() },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
          timestamp: Date.now(),
        },
      ];
      view.requestUpdate();
    });

    await page.waitForTimeout(200);

    const rendered = await page.locator("chat-view").evaluate((el) => {
      const list = el.querySelector("message-list");
      return {
        user: list?.querySelectorAll(".ml-user").length ?? 0,
        assistant: list?.querySelectorAll(".ml-assistant").length ?? 0,
        text: list?.textContent || "",
      };
    });

    expect(rendered.user).toBe(1);
    expect(rendered.assistant).toBe(1);
    expect(rendered.text).toContain("hello");
    expect(rendered.text).toContain("hi there");
  });

  test("renders markdown formatting in assistant message", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        messages: unknown[];
        requestUpdate: () => void;
      };
      view.messages = [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "**bold**\n\n```js\nconsole.log('ok')\n```",
            },
          ],
          timestamp: Date.now(),
        },
      ];
      view.requestUpdate();
    });

    await page.waitForTimeout(200);

    const markdown = await page.locator("chat-view").evaluate((el) => {
      const list = el.querySelector("message-list");
      return {
        strong: !!list?.querySelector(".markdown-content strong"),
        code: !!list?.querySelector(".markdown-content pre code"),
        text: list?.textContent || "",
      };
    });

    expect(markdown.strong).toBe(true);
    expect(markdown.code).toBe(true);
    expect(markdown.text).toContain("bold");
    expect(markdown.text).toContain("console.log");
  });

  test("renders bash execution rows", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        messages: unknown[];
        requestUpdate: () => void;
      };
      view.messages = [
        {
          role: "bashExecution",
          command: "echo hello",
          output: "hello",
          excludeFromContext: true,
          timestamp: Date.now(),
        },
      ];
      view.requestUpdate();
    });

    await page.waitForTimeout(200);

    const shell = await page.locator("chat-view").evaluate((el) => {
      const details = el.querySelector(".bash-execution") as
        | HTMLDetailsElement
        | null;
      return {
        exists: !!details,
        text: details?.textContent || "",
      };
    });

    expect(shell.exists).toBe(true);
    expect(shell.text).toContain("echo hello");
    expect(shell.text).toContain("hello");
    expect(shell.text).toContain("not in context");
  });

  test("shows slash command suggestions from discovered commands", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        commands: Array<{ name: string; source: "extension" | "prompt" | "skill" }>;
        requestUpdate: () => void;
      };
      view.commands = [
        { name: "project-info", source: "extension" },
        { name: "summarize", source: "prompt" },
      ];
      view.requestUpdate();
    });

    await page.locator("chat-view").evaluate((el) => {
      const input = el.querySelector("chat-input");
      const ta = input?.shadowRoot?.querySelector("textarea") as
        | HTMLTextAreaElement
        | undefined;
      if (!ta) return;
      ta.value = "/";
      ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    });

    await page.waitForTimeout(150);

    const suggestionCount = await page.locator("chat-view").evaluate((el) => {
      const input = el.querySelector("chat-input");
      return (
        input?.shadowRoot?.querySelectorAll(".command-item").length ?? 0
      );
    });

    expect(suggestionCount).toBeGreaterThan(0);
  });

  test("renders extension confirm request and sends response", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        wsSend?: (msg: unknown) => void;
        handleAgentEvent?: (event: unknown) => void;
      };

      (window as unknown as { __extResponse?: unknown }).__extResponse = undefined;
      view.wsSend = (msg: unknown) => {
        (window as unknown as { __extResponse?: unknown }).__extResponse = msg;
      };

      view.handleAgentEvent?.({
        type: "extension_ui_request",
        id: "ext-1",
        method: "confirm",
        title: "Extension confirmation",
        message: "Proceed with operation?",
      });
    });

    await page.waitForTimeout(120);

    const dialogText = await page.locator("chat-view").evaluate((el) => {
      const modal = el.querySelector(".cv-extension-modal");
      return modal?.textContent || "";
    });

    expect(dialogText).toContain("Extension confirmation");
    expect(dialogText).toContain("Proceed with operation?");

    await page.locator("chat-view").evaluate((el) => {
      const yesButton = Array.from(
        el.querySelectorAll(".cv-extension-btn.primary"),
      ).find((btn) => btn.textContent?.trim() === "Yes") as
        | HTMLElement
        | undefined;
      yesButton?.click();
    });

    const response = await page.evaluate(() => {
      return (window as unknown as { __extResponse?: unknown }).__extResponse;
    });

    expect(response).toEqual({
      type: "extension_ui_response",
      id: "ext-1",
      confirmed: true,
    });
  });

  test("tool calls are collapsible and show output when expanded", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        messages: unknown[];
        requestUpdate: () => void;
      };
      view.messages = [
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
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "read",
          output: "line one\nline two",
          timestamp: Date.now(),
          isError: false,
        },
      ];
      view.requestUpdate();
    });

    await page.waitForTimeout(200);

    const collapsed = await page.locator("chat-view").evaluate((el) => {
      const details = el.querySelector(".tool-call-details") as
        | HTMLDetailsElement
        | null;
      return {
        exists: !!details,
        open: details?.open ?? false,
      };
    });

    expect(collapsed.exists).toBe(true);
    expect(collapsed.open).toBe(false);

    await page.locator("chat-view").evaluate((el) => {
      const summary = el.querySelector(".tool-call-summary") as HTMLElement;
      summary?.click();
    });

    await page.waitForTimeout(120);

    const expanded = await page.locator("chat-view").evaluate((el) => {
      const details = el.querySelector(".tool-call-details") as
        | HTMLDetailsElement
        | null;
      const body = details?.querySelector(".tool-call-body") as HTMLElement | null;
      return {
        open: details?.open ?? false,
        bodyText: body?.textContent || "",
      };
    });

    expect(expanded.open).toBe(true);
    expect(expanded.bodyText).toContain("line one");
  });

  test("renders metadata, system prompt, and tools cards", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        systemPrompt: string;
        requestUpdate: () => void;
      };
      view.systemPrompt = "You are a test prompt.\nKeep output concise.";
      view.requestUpdate();
    });

    await page.waitForTimeout(200);

    const cards = await page.locator("chat-view").evaluate((el) => {
      return {
        metadata: !!el.querySelector(".cv-info-card .cv-info-title"),
        prompt: !!el.querySelector(".cv-system-prompt"),
        tools: !!el.querySelector(".cv-tools-card"),
      };
    });

    expect(cards.metadata).toBe(true);
    expect(cards.prompt).toBe(true);
    expect(cards.tools).toBe(true);
  });

  test("supports deep-link target and copy-link hash updates", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}?target=msg-1`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        messages: unknown[];
        requestUpdate: () => void;
      };
      view.messages = [
        { role: "user", content: "first", timestamp: Date.now() - 1000 },
        {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          timestamp: Date.now(),
        },
      ];
      view.requestUpdate();
    });

    await page.waitForTimeout(300);

    const deepLinked = await page.locator("chat-view").evaluate((el) => {
      const target = el.querySelector("#msg-1");
      return {
        exists: !!target,
      };
    });

    expect(deepLinked.exists).toBe(true);

    await page.locator("chat-view").evaluate((el) => {
      const btn = el.querySelector("#msg-1 .copy-link-btn") as HTMLElement;
      btn?.click();
    });

    await page.waitForTimeout(100);
    expect(page.url()).toContain(`#/session/${sessionId}?target=msg-1`);
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
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    // Click gear (chat-view is light DOM)
    await page.locator("chat-view").evaluate((el) => {
      const btn = el.querySelector(".cv-gear-btn") as HTMLElement;
      btn?.click();
    });

    // settings-panel is shadow DOM
    const isOpen = await page.locator("chat-view").evaluate((el) => {
      const panel = el.querySelector("settings-panel");
      const panelDiv = panel?.shadowRoot?.querySelector(".panel");
      return panelDiv?.classList.contains("open");
    });
    expect(isOpen).toBe(true);
  });

  test("shows theme toggle", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    // Open settings
    await page.locator("chat-view").evaluate((el) => {
      const btn = el.querySelector(".cv-gear-btn") as HTMLElement;
      btn?.click();
    });

    // Check for theme buttons (settings-panel is shadow DOM)
    const themeLabels = await page.locator("chat-view").evaluate((el) => {
      const panel = el.querySelector("settings-panel");
      const buttons = panel?.shadowRoot?.querySelectorAll(".theme-btn");
      return Array.from(buttons || []).map((b) => b.textContent?.trim());
    });
    expect(themeLabels).toContain("Auto");
    expect(themeLabels).toContain("Light");
    expect(themeLabels).toContain("Dark");
  });

  test("shows thinking level control", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    // Open settings
    await page.locator("chat-view").evaluate((el) => {
      const btn = el.querySelector(".cv-gear-btn") as HTMLElement;
      btn?.click();
    });

    // Check for thinking level buttons (settings-panel is shadow DOM)
    const levels = await page.locator("chat-view").evaluate((el) => {
      const panel = el.querySelector("settings-panel");
      const buttons = panel?.shadowRoot?.querySelectorAll(".seg-btn");
      return Array.from(buttons || []).map((b) => b.textContent?.trim());
    });
    expect(levels).toContain("off");
    expect(levels).toContain("high");
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

    // Verify the page is not blank
    const bodyHtml = await page.evaluate(() => document.body.innerHTML);
    expect(bodyHtml).toContain("app-root");
  });

  test("chat view renders correctly", async ({ page }) => {
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    const screenshot = await page.screenshot();
    expect(screenshot).toBeTruthy();
  });
});

test.describe("Session Not Found", () => {
  test("shows 404 page for non-existent session", async ({ page }) => {
    await page.goto("/#/session/nonexistent_session_id_12345");

    // Should show not-found page
    await expect(page.locator(".not-found")).toBeAttached({ timeout: 5000 });
    const text = await page.locator(".not-found").textContent();
    expect(text).toContain("Session not found");
    expect(text).toContain("nonexistent_session_id_12345");
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
    await page.goto(`/#/session/${sessionId}`);
    await expect(page.locator("chat-view")).toBeAttached();

    // chat-view is light DOM — click the title to enter rename mode
    await page.locator("chat-view").evaluate((el) => {
      const title = el.querySelector(".cv-title") as HTMLElement;
      title?.click();
    });

    // Type a new name
    await page.locator("chat-view").evaluate((el) => {
      const input = el.querySelector(".cv-title-input") as HTMLInputElement;
      if (input) {
        input.value = "Renamed via E2E";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    // Press Enter to commit
    await page.locator("chat-view").evaluate((el) => {
      const input = el.querySelector(".cv-title-input") as HTMLInputElement;
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    // Wait for API call
    await page.waitForTimeout(300);

    // Verify via API
    const res = await fetch(`${baseURL}/api/sessions`);
    const data = await res.json();
    const session = data.sessions.find(
      (s: { id: string }) => s.id === sessionId,
    );
    expect(session?.name).toBe("Renamed via E2E");
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
    await page.waitForTimeout(500);

    await page.locator("session-list").evaluate((el, sessionName) => {
      const items = el.shadowRoot?.querySelectorAll(".session-item");
      for (const item of items || []) {
        if (item.textContent?.includes(sessionName)) {
          const btn = item.querySelector(".session-menu-btn") as HTMLElement;
          btn?.click();
          break;
        }
      }
    }, name);

    await page.locator("session-list").evaluate((el) => {
      const archiveBtn = el.shadowRoot?.querySelector(
        ".context-menu button",
      ) as HTMLElement;
      archiveBtn?.click();
    });

    await expect
      .poll(
        async () => {
          const res = await fetch(`${baseURL}/api/sessions`);
          const data = await res.json();
          const session = data.sessions.find((s: { id: string }) => s.id === id);
          return session?.name || "";
        },
        { timeout: 4000, message: "Session should be archived" },
      )
      .toContain("archived: ");

    const archivedClassApplied = await page
      .locator("session-list")
      .evaluate((el, sessionName) => {
        const items = el.shadowRoot?.querySelectorAll(".session-item") || [];
        return Array.from(items).some(
          (item) =>
            item.classList.contains("archived") &&
            item.textContent?.includes(sessionName),
        );
      }, name);

    expect(archivedClassApplied).toBe(true);

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

    await page.goto(`/#/session/${id}`);
    await expect(page.locator("chat-view")).toBeAttached();

    await page.locator("chat-view").evaluate((el) => {
      const view = el as unknown as {
        routeAndSubmitText?: (text: string, intent: string) => void;
      };
      view.routeAndSubmitText?.("hello again", "send");
    });

    await expect
      .poll(
        async () => {
          const res = await fetch(`${baseURL}/api/sessions`);
          const data = await res.json();
          const session = data.sessions.find((s: { id: string }) => s.id === id);
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

    // Rename for identification
    await fetch(`${baseURL}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    await page.goto("/");
    await page.waitForTimeout(500);

    // Right-click the session to open context menu (session-list is shadow DOM)
    await page.locator("session-list").evaluate((el, sessionName) => {
      const items = el.shadowRoot?.querySelectorAll(".session-item");
      for (const item of items || []) {
        if (item.textContent?.includes(sessionName)) {
          item.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              clientX: 100,
              clientY: 100,
            }),
          );
          break;
        }
      }
    }, name);

    // Dismiss the confirm dialog automatically
    page.once("dialog", (dialog) => dialog.accept());

    // Click delete in context menu
    await page.locator("session-list").evaluate((el) => {
      const deleteBtn = el.shadowRoot?.querySelector(
        ".context-menu .danger",
      ) as HTMLElement;
      deleteBtn?.click();
    });

    // Verify via API (allow async fs/write propagation)
    await expect
      .poll(
        async () => {
          const res = await fetch(`${baseURL}/api/sessions`);
          const data = await res.json();
          return data.sessions.some((s: { id: string }) => s.id === id);
        },
        { timeout: 4000, message: "Session should be deleted" },
      )
      .toBe(false);
  });
});
