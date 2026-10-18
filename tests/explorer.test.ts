import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exploreApplication, type ExplorationBrowser } from "../src/browser/explorer.js";
import type { DiscoveredTool } from "../src/browser/tool-policy.js";

const targetUrl = "https://app.example.test/";
const tools = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_take_screenshot", inputSchema: { type: "object", properties: { filename: { type: "string" } } } },
] as DiscoveredTool[];

const tempDirectories: string[] = [];

async function makeOutputPaths(): Promise<{ directory: string; outputPath: string; screenshotPath: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), "application-explorer-"));
  tempDirectories.push(directory);
  return {
    directory,
    outputPath: resolve(directory, "application-context.json"),
    screenshotPath: resolve(directory, "screenshots", "exploration.png"),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function mockBrowser(options: {
  snapshot?: { text: string; isError?: boolean };
  navigation?: { text: string; isError?: boolean };
  connectError?: Error;
  screenshotError?: Error;
} = {}): ExplorationBrowser {
  return {
    connect: vi.fn(async () => {
      if (options.connectError) throw options.connectError;
      return tools;
    }),
    call: vi.fn(async (name: string) => {
      if (name === "browser_navigate") return options.navigation ?? { text: "Navigated", isError: false, raw: {} };
      return options.snapshot ?? { text: snapshotResponse, isError: false, raw: {} };
    }),
    screenshot: vi.fn(async (path: string) => {
      if (options.screenshotError) throw options.screenshotError;
      await writeFile(path, Buffer.from("mock screenshot"));
    }),
    close: vi.fn(async () => undefined),
  };
}

const snapshotResponse = `### Page
- Page URL: https://app.example.test/
- Page Title: Observed application
### Snapshot
\`\`\`yaml
- main [ref=e1]:
  - heading "Observed application" [level=1] [ref=e2]
  - textbox "Search items" [active] [ref=e3]
  - button "Apply filter" [disabled] [ref=e4]
  - link "Help" [ref=e5] [cursor=pointer]:
    - /url: https://app.example.test/help
\`\`\``;

describe("application exploration", () => {
  it("persists a validated context derived only from observed MCP data", async () => {
    const paths = await makeOutputPaths();
    const browser = mockBrowser();
    const context = await exploreApplication({
      targetUrl,
      runId: "unit-run",
      headless: true,
      outputPath: paths.outputPath,
      screenshotPath: paths.screenshotPath,
      createBrowser: () => browser,
      logAction: async () => undefined,
    });
    const persisted = JSON.parse(await readFile(paths.outputPath, "utf8"));

    expect(context.status).toBe("PASS");
    expect(context.page).toMatchObject({
      title: "Observed application",
      currentUrl: targetUrl,
      accessibilitySnapshot: expect.stringContaining('textbox "Search items"'),
    });
    expect(context.page.visibleSemanticControls).toEqual([
      { role: "textbox", name: "Search items", reference: "e3", observedAttributes: ["active"] },
      { role: "button", name: "Apply filter", reference: "e4", observedAttributes: ["disabled"] },
      { role: "link", name: "Help", reference: "e5", observedAttributes: [] },
    ]);
    expect(context.unknowns[0]).toMatch(/not represented in the captured accessibility snapshot/);
    expect(context.page.visibleSemanticControls.some(({ name }) => name.toLowerCase().includes("delete"))).toBe(false);
    expect(context).toEqual(persisted);
    expect(context.sourceReferences.snapshotTool).toBe("browser_snapshot");
    expect(context.evidence.screenshot).toContain("exploration.png");
    expect(await readFile(paths.screenshotPath, "utf8")).toBe("mock screenshot");
    expect(browser.call).toHaveBeenCalledTimes(2);
    expect(browser.call).toHaveBeenNthCalledWith(1, "browser_navigate", { url: targetUrl });
    expect(browser.call).toHaveBeenNthCalledWith(2, "browser_snapshot", {});
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("blocks navigation errors with diagnostics and does not request a snapshot", async () => {
    const paths = await makeOutputPaths();
    const browser = mockBrowser({ navigation: { text: "Connection refused", isError: true } });
    const context = await exploreApplication({
      targetUrl,
      runId: "navigation-error",
      headless: true,
      outputPath: paths.outputPath,
      screenshotPath: paths.screenshotPath,
      createBrowser: () => browser,
      logAction: async () => undefined,
    });
    expect(context.status).toBe("BLOCKED");
    expect(context.diagnostics).toContainEqual({ stage: "navigation", message: "Navigation failed: Connection refused" });
    expect(context.page.accessibilitySnapshot).toBeNull();
    expect(browser.call).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(paths.outputPath, "utf8")).status).toBe("BLOCKED");
  });

  it("blocks a missing accessibility snapshot and reports snapshot-tool errors", async () => {
    const paths = await makeOutputPaths();
    const browser = mockBrowser({ snapshot: { text: "", isError: false } });
    const context = await exploreApplication({
      targetUrl,
      runId: "missing-snapshot",
      headless: true,
      outputPath: paths.outputPath,
      screenshotPath: paths.screenshotPath,
      createBrowser: () => browser,
      logAction: async () => undefined,
    });
    expect(context.status).toBe("BLOCKED");
    expect(context.diagnostics[0]).toMatchObject({ stage: "snapshot" });
    expect(context.page.title).toBeNull();

    const pathsForError = await makeOutputPaths();
    const failedBrowser = mockBrowser({ snapshot: { text: "MCP snapshot failure", isError: true } });
    const failedContext = await exploreApplication({
      targetUrl,
      runId: "snapshot-error",
      headless: true,
      outputPath: pathsForError.outputPath,
      screenshotPath: pathsForError.screenshotPath,
      createBrowser: () => failedBrowser,
      logAction: async () => undefined,
    });
    expect(failedContext.status).toBe("BLOCKED");
    expect(failedContext.diagnostics[0]?.message).toBe("Browser snapshot tool failed: MCP snapshot failure");
  });

  it("blocks off-origin redirects and screenshot failures", async () => {
    const paths = await makeOutputPaths();
    const redirected = mockBrowser({
      snapshot: {
        text: snapshotResponse.replace("https://app.example.test/", "https://elsewhere.example/"),
        isError: false,
      },
    });
    const redirectedContext = await exploreApplication({
      targetUrl,
      runId: "redirected",
      headless: true,
      outputPath: paths.outputPath,
      screenshotPath: paths.screenshotPath,
      createBrowser: () => redirected,
      logAction: async () => undefined,
    });
    expect(redirectedContext.status).toBe("BLOCKED");
    expect(redirectedContext.diagnostics[0]?.message).toMatch(/outside the target origin/);

    const screenshotPaths = await makeOutputPaths();
    const screenshotFailure = mockBrowser({ screenshotError: new Error("Screenshot unavailable") });
    const screenshotContext = await exploreApplication({
      targetUrl,
      runId: "screenshot-error",
      headless: true,
      outputPath: screenshotPaths.outputPath,
      screenshotPath: screenshotPaths.screenshotPath,
      createBrowser: () => screenshotFailure,
      logAction: async () => undefined,
    });
    expect(screenshotContext.status).toBe("BLOCKED");
    expect(screenshotContext.diagnostics[0]).toEqual({ stage: "screenshot", message: "Screenshot unavailable" });
    expect(screenshotContext.page.accessibilitySnapshot).not.toBeNull();
    expect(screenshotContext.evidence.screenshot).toBeNull();
  });

  it("blocks MCP connection failures without claiming page observations", async () => {
    const paths = await makeOutputPaths();
    const browser = mockBrowser({ connectError: new Error("MCP server unavailable") });
    const context = await exploreApplication({
      targetUrl,
      runId: "connection-error",
      headless: true,
      outputPath: paths.outputPath,
      screenshotPath: paths.screenshotPath,
      createBrowser: () => browser,
      logAction: async () => undefined,
    });
    expect(context.status).toBe("BLOCKED");
    expect(context.diagnostics[0]).toEqual({ stage: "connect", message: "MCP server unavailable" });
    expect(context.page).toMatchObject({ title: null, currentUrl: null, accessibilitySnapshot: null, visibleSemanticControls: [] });
  });
});
