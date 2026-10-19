import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/evidence/logger.js", () => ({ appendActionLog: vi.fn(async () => undefined) }));

import { executeScenario, type BrowserAgent, type ExecutorLimits, type JsonAgent } from "../src/agents/executor.js";
import { appendActionLog } from "../src/evidence/logger.js";
import type { DiscoveredTool } from "../src/browser/tool-policy.js";
import type { ExecutorDecision, NormalizedIssue, PlannedScenario } from "../src/schemas.js";

const runId = "FILTER-READINESS";
const uniqueText = `QA-${runId}-SC-FILTER`;
const activeText = `${uniqueText}-ACTIVE`;
const completedText = `${uniqueText}-COMPLETED`;
const issue: NormalizedIssue = {
  issueNumber: 1,
  title: "Task filtering",
  status: "RFQA",
  targetUrl: "https://demo.playwright.dev/todomvc/",
  description: "Verify filtering against independently observed active and completed tasks.",
  acceptanceCriteria: [{ id: "AC-FILTER", description: "The Active filter hides completed tasks and shows active tasks." }],
};
const scenario: PlannedScenario = {
  id: "SC-FILTER",
  title: "Filter independently created active and completed tasks",
  acceptanceCriteriaIds: ["AC-FILTER"],
  preconditions: [],
  steps: [
    { intent: "Create an active task", expectedObservation: "The active task appears with an unchecked checkbox" },
    { intent: "Create another task and mark it complete", expectedObservation: "Both tasks are visible and the second task is checked" },
    { intent: "Select the Active filter", expectedObservation: "Only the active task remains visible" },
  ],
  verificationStrategy: "Observe both identities and completion states before independently checking the filter result.",
  verificationChecks: [{
    acceptanceCriterionId: "AC-FILTER", kind: "filter",
    expectedVisible: ["{{uniqueTaskText}}-ACTIVE"], expectedAbsent: ["{{uniqueTaskText}}-COMPLETED"],
  }],
  relevantApplicationContext: ["The current accessibility snapshot contains the textbox, task toggles and filter links."],
  unknownControlsToDiscover: [],
  expectedResult: "The Active filter shows the current scenario's active task and hides its completed task.",
};
const tools: DiscoveredTool[] = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
  { name: "browser_snapshot", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_type", inputSchema: { type: "object", properties: { target: { type: "string" }, text: { type: "string" } }, required: ["target", "text"], additionalProperties: false } },
  { name: "browser_click", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false } },
];
type Item = { text: string; checked: boolean };
const typeTask = (text: string): ExecutorDecision => ({ kind: "action", toolName: "browser_type", arguments: { target: "e8", text }, rationale: "Create the required task through the observed textbox." });
const click = (target: string): ExecutorDecision => ({ kind: "action", toolName: "browser_click", arguments: { target }, rationale: "Use the currently observed control to satisfy the generated verification requirements." });
const finish = (): ExecutorDecision => ({
  kind: "finish", assessments: [{ acceptanceCriteriaId: "AC-FILTER", meets: true, observedEvidence: "The Active filter shows the active task and hides the completed task.", explanation: "The model believes filtering is complete; host verification is authoritative." }],
  rationale: "The model proposes finishing the scenario.",
});

class FilterAgent implements JsonAgent {
  readonly prompts: string[] = [];
  constructor(private readonly decisions: ExecutorDecision[], private readonly onRequest?: (request: number) => void) {}
  async generateJson(prompt: string): Promise<unknown> {
    this.prompts.push(prompt);
    this.onRequest?.(this.prompts.length);
    return this.decisions.shift() ?? finish();
  }
}

// This fake only implements observed controls. Each selected tool mutates UI state;
// the host receives the resulting real-shape accessibility snapshot separately.
class FilterBrowser implements BrowserAgent {
  readonly discoveredTools = tools;
  readonly actions: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  readonly items: Item[];
  active = false;
  constructor(initialItems: Item[] = [], private readonly filterDefect = false, private readonly nativeSnapshot = false) {
    this.items = initialItems.map((item) => ({ ...item }));
  }
  snapshot(): string {
    return [
      "### Page",
      `- Page URL: https://demo.playwright.dev/todomvc/#/${this.active ? "active" : ""}`,
      "- Page Title: React TodoMVC",
      "### Snapshot",
      "```yaml",
      "- generic [ref=e1]:",
      "  - generic [ref=e5]:",
      '    - heading "todos" [level=1] [ref=e7]',
      '    - textbox "What needs to be done?" [ref=e8]',
      "    - generic [ref=e15]:",
      '      - checkbox "Mark all as complete" [ref=e16] [unchecked]',
      "      - list [ref=e18]:",
      ...this.items.flatMap((item, index) => {
        if (this.active && item.checked && !this.filterDefect) return [];
        const ref = 19 + index * 5;
        return [
          `        - listitem [ref=e${ref}]:`,
          `          - generic [ref=e${ref + 1}]:`,
          `            - checkbox "Toggle Todo" [ref=e${ref + 2}]${item.checked ? " [checked]" : this.nativeSnapshot ? "" : " [unchecked]"}`,
          `            - generic [ref=e${ref + 3}]: ${item.text}`,
          `            - button "Delete" [ref=e${ref + 4}]`,
        ];
      }),
      "    - list [ref=e40]:",
      "      - listitem [ref=e41]:",
      `        - link "All" [ref=e44]${this.active ? "" : " [current]"}:`,
      '          - /url: "#/"',
      "      - listitem [ref=e42]:",
      `        - link "Active" [ref=e43]${this.active ? this.nativeSnapshot ? " [active]" : " [current]" : ""}:`,
      '          - /url: "#/active"',
      "```",
    ].join("\n");
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    if (name === "browser_snapshot") return { text: this.snapshot(), isError: false, raw: {} };
    this.actions.push({ name, arguments: args });
    if (name === "browser_navigate") return { text: "Navigation succeeded.", isError: false, raw: {} };
    if (name === "browser_type") this.items.push({ text: String(args.text), checked: false });
    else if (name === "browser_click") {
      if (args.target === "e43") this.active = true;
      else if (args.target === "e44") this.active = false;
      else {
        const index = this.items.findIndex((_item, itemIndex) => args.target === `e${21 + itemIndex * 5}`);
        if (index >= 0) this.items[index]!.checked = !this.items[index]!.checked;
        else {
          const deletionIndex = this.items.findIndex((_item, itemIndex) => args.target === `e${23 + itemIndex * 5}`);
          if (deletionIndex < 0) throw new Error(`Unknown task control ${String(args.target)}`);
          this.items.splice(deletionIndex, 1);
        }
      }
    } else throw new Error(`Unexpected browser tool ${name}`);
    return { text: "Browser interaction succeeded.", isError: false, raw: {} };
  }
  async screenshot(path: string): Promise<void> { await writeFile(path, "Mock screenshot artifact."); }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function run(options: {
  decisions: ExecutorDecision[];
  browser?: FilterBrowser;
  limits?: Partial<ExecutorLimits>;
  onRequest?: (request: number) => void;
}) {
  const screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-filter-readiness-"));
  temporaryDirectories.push(screenshotDirectory);
  const browser = options.browser ?? new FilterBrowser();
  const agent = new FilterAgent(options.decisions, options.onRequest);
  const result = await executeScenario({
    agent, browser, issue, scenario, runId, scenarioIndex: 1, screenshotDirectory,
    limits: { maxActions: 10, maxModelRequests: 14, maxSeconds: 20, maxRecoveryRetries: 1, ...options.limits },
  });
  return { result, browser, agent };
}

describe("host-controlled filter finish readiness", () => {
  it("continues after premature finish and autonomously recovers from selecting Active too early", async () => {
    const { result, browser, agent } = await run({ decisions: [
      typeTask(activeText), click("e43"), finish(),
      click("e44"), typeTask(completedText), click("e26"), click("e43"), finish(),
    ] });
    expect(result.status, result.reason).toBe("PASS");
    expect(result.hostVerification).toMatchObject([{ acceptanceCriterionId: "AC-FILTER", status: "PASS" }]);
    expect(result.actionCount).toBe(6);
    expect(result.modelRequestCount).toBe(8);
    expect(result.recoveryCount).toBe(0);
    expect(agent.prompts[3]).toContain(completedText);
    expect(agent.prompts[3]).toMatch(/finish|readiness|missing/i);
    expect(agent.prompts[3]).toMatch(/checked|complet/i);
    expect(browser.actions.map(({ name, arguments: args }) => `${name}:${String(args.target ?? "")}`)).toEqual([
      "browser_navigate:", "browser_type:e8", "browser_click:e43", "browser_click:e44", "browser_type:e8", "browser_click:e26", "browser_click:e43",
    ]);
    expect(browser.items).toEqual([{ text: activeText, checked: false }, { text: completedText, checked: true }]);
    expect(result.hostVerification?.[0]?.evidence.length).toBeGreaterThan(0);
    const deferred = vi.mocked(appendActionLog).mock.calls.map(([entry]) => entry).filter(({ event }) => event === "finish_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ status: "not_ready", hostVerification: [{ status: "BLOCKED" }], modelAssessments: [{ meets: true }] });
    expect(deferred[0]?.snapshotReferences).toHaveLength(3);
  });

  it("handles native TodoMVC unchecked boxes and link targets without inventing selected-state attributes", async () => {
    const { result } = await run({ browser: new FilterBrowser([], false, true), decisions: [
      typeTask(activeText), typeTask(completedText), click("e26"), click("e43"), finish(),
    ] });
    expect(result.status, result.reason).toBe("PASS");
    expect(result.hostVerification).toMatchObject([{ status: "PASS" }]);
  });

  it("does not accept two visible identities as completion proof when the excluded task was never checked", async () => {
    const { result, agent } = await run({
      decisions: [typeTask(activeText), typeTask(completedText), click("e43"), finish(), finish()],
      limits: { maxModelRequests: 5 },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.modelRequestCount).toBe(5);
    expect(agent.prompts[4]).toContain(completedText);
    expect(agent.prompts[4]).toMatch(/checked|complet/i);
    expect(result.hostVerification?.some(({ status }) => status === "PASS")).not.toBe(true);
  });

  it("does not borrow completed-task proof from tasks belonging to an earlier run", async () => {
    const browser = new FilterBrowser([
      { text: "QA-OLDER-RUN-SC-FILTER-ACTIVE", checked: false },
      { text: "QA-OLDER-RUN-SC-FILTER-COMPLETED", checked: true },
    ]);
    const { result, agent } = await run({ browser, decisions: [typeTask(activeText), click("e43"), finish(), finish()], limits: { maxModelRequests: 4 } });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.actionCount).toBe(2);
    expect(agent.prompts[3]).toContain(completedText);
    expect(result.hostVerification?.some(({ status }) => status === "PASS")).not.toBe(true);
  });

  it("does not use only initial-state tasks as the required post-action observations", async () => {
    const browser = new FilterBrowser([{ text: activeText, checked: false }, { text: completedText, checked: true }]);
    const { result } = await run({ browser, decisions: [finish(), finish()], limits: { maxModelRequests: 2 } });
    expect(result.status).toBe("BLOCKED");
    expect(result.actionCount).toBe(0);
    expect(result.modelRequestCount).toBe(2);
    expect(browser.actions).toHaveLength(1);
  });

  it("does not treat preexisting matching identities as newly created after an unrelated successful action", async () => {
    const browser = new FilterBrowser([{ text: activeText, checked: false }, { text: completedText, checked: true }]);
    const { result } = await run({ browser, decisions: [click("e44"), click("e43"), finish()], limits: { maxModelRequests: 3 } });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.hostVerification?.[0]?.reason).toMatch(/absent earlier/);
  });

  it("does not mistake an early filter hiding a preexisting completed task for fresh creation evidence", async () => {
    const browser = new FilterBrowser([{ text: activeText, checked: false }, { text: completedText, checked: true }]);
    const { result } = await run({ browser, decisions: [click("e43"), click("e44"), click("e43"), finish()], limits: { maxModelRequests: 4 } });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.hostVerification?.[0]?.reason).toMatch(/excluded item.*checked/);
  });

  it("bounds repeated premature finish proposals by the existing model-request budget", async () => {
    const { result, browser, agent } = await run({ decisions: [finish()], limits: { maxModelRequests: 3 } });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/request budget/i);
    expect(result.modelRequestCount).toBe(3);
    expect(agent.prompts).toHaveLength(3);
    expect(result.actionCount).toBe(0);
    expect(browser.actions).toHaveLength(1);
  });

  it("does not execute recovery actions after the existing browser-action budget is exhausted", async () => {
    const { result, browser } = await run({
      decisions: [typeTask(activeText), click("e43"), finish(), typeTask(completedText)],
      limits: { maxActions: 2 },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/action budget/i);
    expect(result.actionCount).toBe(2);
    expect(result.modelRequestCount).toBe(3);
    expect(browser.items.some(({ text }) => text === completedText)).toBe(false);
    expect(browser.actions).toHaveLength(3);
  });

  it("does not accept a decision or execute an action after the scenario deadline during readiness recovery", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result, browser } = await run({
      decisions: [finish(), typeTask(activeText)],
      limits: { maxSeconds: 1 },
      onRequest: (request) => { if (request === 2) now = 2_001; },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/time limit/i);
    expect(result.modelRequestCount).toBe(2);
    expect(result.actionCount).toBe(0);
    expect(browser.items).toEqual([]);
  });

  it("reports a real filter contradiction as FAIL after independently observing both required states", async () => {
    const { result } = await run({
      browser: new FilterBrowser([], true),
      decisions: [typeTask(activeText), typeTask(completedText), click("e26"), click("e43"), finish()],
    });
    expect(result.status, result.reason).toBe("FAIL");
    expect(result.hostVerifiedFailure).toBe(true);
    expect(result.hostVerification).toMatchObject([{ acceptanceCriterionId: "AC-FILTER", status: "FAIL" }]);
    expect(result.reason).toMatch(/contradict|visible completed/i);
    expect(result.actionCount).toBe(4);
    expect(result.modelRequestCount).toBe(5);
  });

  it.each([
    ["deleting the excluded task", "e28"],
    ["making the excluded task active again", "e26"],
  ])("does not reuse earlier valid setup after %s", async (_description, changedControl) => {
    const { result } = await run({
      decisions: [typeTask(activeText), typeTask(completedText), click("e26"), click(changedControl), click("e43"), finish()],
      limits: { maxModelRequests: 6 },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.hostVerification?.[0]?.reason).toMatch(/excluded item.*checked checkbox/);
    expect(result.hostVerification?.some(({ status }) => status === "PASS")).toBe(false);
  });
});
