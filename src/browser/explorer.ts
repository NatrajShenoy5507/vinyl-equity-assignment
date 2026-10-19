import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { z } from "zod";
import { appendActionLog, evidenceDirectory } from "../evidence/logger.js";
import { PlaywrightMcp } from "./playwright-mcp.js";
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from "./browser-errors.js";
import { validateToolAction, type DiscoveredTool } from "./tool-policy.js";

const semanticControlRoles = [
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
] as const;

const semanticControlSchema = z.object({
  role: z.enum(semanticControlRoles),
  name: z.string(),
  reference: z.string().regex(/^e\d+$/).optional(),
  observedAttributes: z.array(z.string()),
});

export const applicationContextSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  status: z.enum(["PASS", "BLOCKED"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  targetUrl: z.string().url(),
  page: z.object({
    title: z.string().nullable(),
    currentUrl: z.string().url().nullable(),
    observedAt: z.string().datetime().nullable(),
    accessibilitySnapshot: z.string().min(1).nullable(),
    visibleSemanticControls: z.array(semanticControlSchema),
  }),
  evidence: z.object({
    screenshot: z.string().nullable(),
    accessibilitySnapshotSource: z.literal("page.accessibilitySnapshot"),
  }),
  sourceReferences: z.object({
    targetUrl: z.string().url(),
    navigationTool: z.literal("browser_navigate"),
    snapshotTool: z.literal("browser_snapshot"),
    screenshotTool: z.literal("browser_take_screenshot"),
  }),
  unknowns: z.array(z.string()),
  diagnostics: z.array(z.object({
    stage: z.enum(["connect", "navigation", "snapshot", "screenshot", "shutdown"]),
    message: z.string().min(1),
  })),
});

export type ApplicationContext = z.infer<typeof applicationContextSchema>;

export interface ExplorationBrowser {
  connect(): Promise<DiscoveredTool[]>;
  call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<{ text: string; isError: boolean; raw: unknown }>;
  screenshot(filePath: string): Promise<void>;
  close(): Promise<void>;
}

export interface ExploreApplicationOptions {
  targetUrl: string;
  runId: string;
  headless: boolean;
  navigationTimeoutMs?: number;
  outputPath?: string;
  screenshotPath?: string;
  createBrowser?: (headless: boolean) => ExplorationBrowser;
  logAction?: (event: Record<string, unknown>) => Promise<void>;
}

function parseSnapshotResponse(response: string): {
  title: string;
  currentUrl: string;
  accessibilitySnapshot: string;
  visibleSemanticControls: ApplicationContext["page"]["visibleSemanticControls"];
} {
  const urlMatch = response.match(/^\s*-\s*Page URL:\s*(.+?)\s*$/im);
  const titleMatch = response.match(/^\s*-\s*Page Title:\s*(.*?)\s*$/im);
  const snapshotMatch = response.match(/(?:^|\n)### Snapshot\s*\n([\s\S]*)$/i);
  if (!urlMatch?.[1] || !titleMatch || !snapshotMatch) {
    throw new Error("Browser snapshot did not include the observed page URL, page title, and accessibility snapshot.");
  }
  const currentUrl = urlMatch[1].trim();
  try {
    new URL(currentUrl);
  } catch {
    throw new Error("Browser snapshot reported an invalid current page URL.");
  }
  const accessibilitySnapshot = snapshotMatch[1]!
    .trim()
    .replace(/^```(?:yaml)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!accessibilitySnapshot) throw new Error("Browser snapshot returned an empty accessibility snapshot.");
  return {
    title: titleMatch[1]!.trim(),
    currentUrl,
    accessibilitySnapshot,
    visibleSemanticControls: extractVisibleSemanticControls(accessibilitySnapshot),
  };
}

function extractVisibleSemanticControls(snapshot: string): ApplicationContext["page"]["visibleSemanticControls"] {
  const controls: ApplicationContext["page"]["visibleSemanticControls"] = [];
  const rolePattern = new RegExp(
    `^\\s*-\\s+(${semanticControlRoles.join("|")})(?:\\s+"((?:\\\\.|[^"])*)")?(?=\\s*(?:\\[|:|$))(.*)$`,
    "gm",
  );
  for (const match of snapshot.matchAll(rolePattern)) {
    const attributes = [...(match[3] ?? "").matchAll(/\[([^\]]+)\]/g)]
      .map((attribute) => attribute[1]!)
      .filter((attribute) => !attribute.startsWith("ref=") && attribute !== "cursor=pointer");
    const reference = (match[3] ?? "").match(/\[ref=(e\d+)\]/)?.[1];
    const control = {
      role: match[1] as typeof semanticControlRoles[number],
      name: (match[2] ?? "").replace(/\\"/g, '"'),
      ...(reference ? { reference } : {}),
      observedAttributes: attributes,
    };
    const parsed = semanticControlSchema.safeParse(control);
    if (parsed.success) controls.push(parsed.data);
  }
  return controls;
}

function validateTargetOrigin(targetUrl: string, currentUrl: string): void {
  if (new URL(targetUrl).origin !== new URL(currentUrl).origin) {
    throw new Error(`Exploration was redirected outside the target origin: ${new URL(currentUrl).origin}`);
  }
}

export async function exploreApplication(options: ExploreApplicationOptions): Promise<ApplicationContext> {
  const startedAt = new Date().toISOString();
  const outputPath = resolve(options.outputPath ?? resolve(evidenceDirectory, "application-context.json"));
  const screenshotPath = resolve(options.screenshotPath ?? resolve(evidenceDirectory, "screenshots", options.runId, "exploration.png"));
  const diagnostics: ApplicationContext["diagnostics"] = [];
  const logAction = options.logAction ?? appendActionLog;
  const page: ApplicationContext["page"] = {
    title: null,
    currentUrl: null,
    observedAt: null,
    accessibilitySnapshot: null,
    visibleSemanticControls: [],
  };
  let screenshot: string | null = null;
  let browser: ExplorationBrowser | undefined;
  let tools: DiscoveredTool[] = [];

  const recordFailure = async (stage: ApplicationContext["diagnostics"][number]["stage"], error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push({ stage, message });
    await logAction({
      timestamp: new Date().toISOString(),
      runId: options.runId,
      event: "application_exploration_blocked",
      stage,
      message,
    });
  };

  try {
    browser = (options.createBrowser ?? ((headless) => new PlaywrightMcp(headless, options.navigationTimeoutMs)))(options.headless);
    tools = await browser.connect();
  } catch (error) {
    await recordFailure("connect", error);
  }

  if (browser && tools.length > 0) {
    try {
      const navigateArgs = validateToolAction("browser_navigate", { url: options.targetUrl }, tools, options.targetUrl);
      const navigation = await browser.call("browser_navigate", navigateArgs, options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS);
      if (navigation.isError) throw new Error(`Navigation failed: ${navigation.text}`);
      await logAction({
        timestamp: new Date().toISOString(),
        runId: options.runId,
        toolName: "browser_navigate",
        arguments: { url: options.targetUrl },
        status: "ok",
        result: navigation.text.slice(0, 1500),
      });
    } catch (error) {
      await recordFailure("navigation", error);
    }

    if (diagnostics.length === 0) {
      try {
        const snapshotArgs = validateToolAction("browser_snapshot", {}, tools, options.targetUrl);
        const snapshot = await browser.call("browser_snapshot", snapshotArgs);
        if (snapshot.isError) throw new Error(`Browser snapshot tool failed: ${snapshot.text}`);
        const observed = parseSnapshotResponse(snapshot.text);
        validateTargetOrigin(options.targetUrl, observed.currentUrl);
        page.title = observed.title;
        page.currentUrl = observed.currentUrl;
        page.observedAt = new Date().toISOString();
        page.accessibilitySnapshot = observed.accessibilitySnapshot;
        page.visibleSemanticControls = observed.visibleSemanticControls;
        await logAction({
          timestamp: new Date().toISOString(),
          runId: options.runId,
          toolName: "browser_snapshot",
          status: "ok",
          result: snapshot.text.slice(0, 1500),
        });
      } catch (error) {
        await recordFailure("snapshot", error);
      }
    }

    if (page.accessibilitySnapshot !== null) {
      try {
        await mkdir(resolve(screenshotPath, ".."), { recursive: true });
        await browser.screenshot(screenshotPath);
        screenshot = relative(evidenceDirectory, screenshotPath).replaceAll("\\", "/");
        await logAction({
          timestamp: new Date().toISOString(),
          runId: options.runId,
          toolName: "browser_take_screenshot",
          status: "ok",
          result: screenshot,
        });
      } catch (error) {
        await recordFailure("screenshot", error);
      }
    }
  } else if (diagnostics.length === 0) {
    await recordFailure("connect", new Error("Playwright MCP connected without discovering any tools."));
  }

  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      await recordFailure("shutdown", error);
    }
  }

  const context = applicationContextSchema.parse({
    schemaVersion: 1,
    runId: options.runId,
    status: diagnostics.length === 0 && screenshot !== null ? "PASS" : "BLOCKED",
    startedAt,
    completedAt: new Date().toISOString(),
    targetUrl: options.targetUrl,
    page,
    evidence: {
      screenshot,
      accessibilitySnapshotSource: "page.accessibilitySnapshot",
    },
    sourceReferences: {
      targetUrl: options.targetUrl,
      navigationTool: "browser_navigate",
      snapshotTool: "browser_snapshot",
      screenshotTool: "browser_take_screenshot",
    },
    unknowns: ["Interactive elements not represented in the captured accessibility snapshot were not observed or assessed."],
    diagnostics,
  });
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await logAction({
    timestamp: new Date().toISOString(),
    runId: options.runId,
    event: "application_context_written",
    status: context.status,
    path: relative(evidenceDirectory, outputPath).replaceAll("\\", "/"),
  });
  return context;
}

export function createExplorationRunId(): string {
  return `exploration-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
