import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/evidence/logger.js", () => ({ appendActionLog: vi.fn(async () => undefined) }));

import { executeScenario, type BrowserAgent, type JsonAgent } from "../src/agents/executor.js";
import type { DiscoveredTool } from "../src/browser/tool-policy.js";
import type { ExecutorDecision, NormalizedIssue, PlannedScenario } from "../src/schemas.js";

const runId = "FINISH-REGRESSION";
const taskText = `QA-${runId}-SC-01`;
const issue: NormalizedIssue = {
  issueNumber: 1,
  title: "Todo management",
  status: "RFQA",
  targetUrl: "https://demo.playwright.dev/todomvc/",
  description: "Verify Todo state using independently captured accessibility snapshots.",
  acceptanceCriteria: [{ id: "AC-01", description: "The task satisfies the expected final UI state." }],
};
const scenario: PlannedScenario = {
  id: "SC-01",
  title: "Create a Todo",
  acceptanceCriteriaIds: ["AC-01"],
  preconditions: [],
  steps: [{ intent: "Create a Todo", expectedObservation: "The created task is visible in the list" }],
  verificationStrategy: "Verify semantic task-list content in the authentic final accessibility snapshot.",
  verificationChecks: [{ acceptanceCriterionId: "AC-01", kind: "visible", expectedVisible: ["{{uniqueTaskText}}"], expectedAbsent: [] }],
  relevantApplicationContext: ["The Todo input is an observed textbox."],
  unknownControlsToDiscover: [],
  expectedResult: "The unique task is visible in the Todo list.",
};
const tools: DiscoveredTool[] = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", inputSchema: { type: "object" } },
  { name: "browser_type", inputSchema: { type: "object", properties: { target: { type: "string" }, text: { type: "string" } }, required: ["target", "text"], additionalProperties: false } },
  { name: "browser_click", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false } },
];

const createDecision: ExecutorDecision = {
  kind: "action",
  toolName: "browser_type",
  arguments: { target: "e8", text: taskText },
  rationale: "Create the uniquely named task using the current observed textbox.",
};
const paraphrase = "The new Todo is now displayed in the task list.";
const finish = (observedEvidence = paraphrase, meets = true): ExecutorDecision => ({
  kind: "finish",
  assessments: [{ acceptanceCriteriaId: "AC-01", meets, observedEvidence, explanation: "Model assessment retained for audit." }],
  rationale: "The requested interaction has completed; independently verify the observed state.",
});

// Matches the real TodoMVC structure from the reported run, including generic
// wrappers between listitem and task text rather than a convenient flat label.
function todoSnapshot(items: Array<{ text: string; state?: "checked" | "unchecked" }> = [], active = false): string {
  return [
    "### Page",
    "- Page URL: https://demo.playwright.dev/todomvc/#/",
    "- Page Title: React TodoMVC",
    "- Console: 1 errors, 0 warnings",
    "### Snapshot",
    "```yaml",
    "- generic [ref=e1]:",
    "  - generic [ref=e5]:",
    "    - generic [ref=e6]:",
    '      - heading "todos" [level=1] [ref=e7]',
    '      - textbox "What needs to be done?" [active] [ref=e8]',
    "    - generic [ref=e15]:",
    '      - checkbox "Mark all as complete" [ref=e16]',
    "      - list [ref=e18]:",
    ...items.flatMap(({ text, state }, index) => {
      const ref = 19 + index * 5;
      return [
        `        - listitem [ref=e${ref}]:`,
        `          - generic [ref=e${ref + 1}]:`,
        `            - checkbox "Toggle Todo" [ref=e${ref + 2}]${state ? ` [${state}]` : ""}`,
        `            - generic [ref=e${ref + 3}]: ${text}`,
        "            - text: Delete",
      ];
    }),
    "    - generic [ref=e40]:",
    "      - list [ref=e41]:",
    "        - listitem [ref=e42]:",
    `          - link "Active" [ref=e43]${active ? " [current]" : ""}:`,
    '            - /url: "#/active"',
    "  - contentinfo [ref=e9]:",
    "    - paragraph [ref=e10]: Double-click to edit a todo",
    "```",
  ].join("\n");
}

type ToolResponse = { text: string; isError: boolean; raw: unknown };
type Snapshot = string | { text: string; isError: boolean };

class FakeAgent implements JsonAgent {
  calls = 0;
  constructor(private readonly decisions: ExecutorDecision[]) {}
  async generateJson(): Promise<unknown> {
    this.calls += 1;
    const decision = this.decisions.shift();
    if (!decision) throw new Error("Unexpected extra model request.");
    return decision;
  }
}

class FakeBrowser implements BrowserAgent {
  readonly discoveredTools = tools;
  readonly calls: string[] = [];
  screenshotCount = 0;
  constructor(
    private readonly snapshots: Snapshot[],
    private readonly options: { actionError?: boolean; missingScreenshotAt?: number } = {},
  ) {}
  async call(name: string): Promise<ToolResponse> {
    this.calls.push(name);
    if (name === "browser_snapshot") {
      const snapshot = this.snapshots.shift() ?? "";
      return { ...(typeof snapshot === "string" ? { text: snapshot, isError: false } : snapshot), raw: {} };
    }
    if (name === "browser_navigate") return { text: "Navigation succeeded.", isError: false, raw: {} };
    if (name === "browser_type") return { text: this.options.actionError ? "Typing failed." : "Typing succeeded.", isError: this.options.actionError ?? false, raw: {} };
    if (name === "browser_click") return { text: "Click succeeded.", isError: false, raw: {} };
    throw new Error(`Unexpected browser tool: ${name}`);
  }
  async screenshot(filePath: string): Promise<void> {
    this.screenshotCount += 1;
    if (this.screenshotCount !== this.options.missingScreenshotAt) {
      await writeFile(filePath, "Unit-test screenshot artifact.");
    }
  }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function run(options: {
  snapshots?: Snapshot[];
  decisions?: ExecutorDecision[];
  scenario?: PlannedScenario;
  actionError?: boolean;
  missingScreenshotAt?: number;
} = {}) {
  const screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-finish-host-"));
  temporaryDirectories.push(screenshotDirectory);
  const browser = new FakeBrowser(options.snapshots ?? [todoSnapshot(), todoSnapshot([{ text: taskText }])], options);
  const agent = new FakeAgent(options.decisions ?? [createDecision, finish()]);
  const result = await executeScenario({
    agent,
    browser,
    issue,
    scenario: options.scenario ?? scenario,
    runId,
    scenarioIndex: 1,
    screenshotDirectory,
    limits: { maxActions: 4, maxModelRequests: 4, maxSeconds: 20, maxRecoveryRetries: 1 },
  });
  return { result, agent, browser };
}

describe("host-authoritative finish evidence", () => {
  it("blocks a finish whose scenario has no independent host check even when the task exists", async () => {
    const { result } = await run({ scenario: { ...scenario, verificationChecks: [] } });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerification).toMatchObject([{ acceptanceCriterionId: "AC-01", status: "BLOCKED" }]);
    expect(result.reason).toContain("No independent host verification check");
    expect(result.modelAssessments).toHaveLength(1);
  });

  it("does not report a criterion PASS when the required final screenshot is unavailable", async () => {
    const { result } = await run({ missingScreenshotAt: 3 });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerification).toMatchObject([{ status: "BLOCKED" }]);
    expect(result.hostVerification?.[0]?.reason).toContain("final screenshot");
    expect(result.modelAssessments).toHaveLength(1);
  });

  it("passes the actual nested TodoMVC structure despite paraphrased model evidence and preserves that assessment", async () => {
    const snapshot = todoSnapshot([{ text: taskText }]);
    const { result, agent } = await run({ snapshots: [todoSnapshot(), snapshot] });
    expect(result.status, result.reason).toBe("PASS");
    expect(result.hostVerification).toMatchObject([{ acceptanceCriterionId: "AC-01", status: "PASS" }]);
    expect(result.modelAssessments).toEqual([{
      acceptanceCriteriaId: "AC-01", meets: true, observedEvidence: paraphrase, explanation: "Model assessment retained for audit.",
      evidenceStatus: "UNSUPPORTED", snapshotReferences: [],
    }]);
    expect(result.modelAssessmentWarnings?.join(" ")).toMatch(/AC-01/);
    expect(agent.calls).toBe(2);

    const references = result.hostVerification?.[0]?.evidence ?? [];
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(isAbsolute(reference)).toBe(true);
      expect(reference).toMatch(/\.txt$/);
      expect(await readFile(reference, "utf8")).toBe(snapshot);
    }
    for (const reference of result.evidence) await access(reference);
    expect(result.observed).not.toContain("### Snapshot");
  });

  it("retains exact model quotes with authenticated snapshot references while host checks determine PASS", async () => {
    const { result } = await run({ decisions: [createDecision, finish(taskText)] });
    expect(result.status, result.reason).toBe("PASS");
    expect(result.modelAssessments).toMatchObject([{
      acceptanceCriteriaId: "AC-01", observedEvidence: taskText, evidenceStatus: "MATCHED_POST_ACTION",
    }]);
    const references = result.modelAssessments?.[0]?.snapshotReferences ?? [];
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(await readFile(reference, "utf8")).toContain(taskText);
      expect(result.hostVerification?.[0]?.evidence).toContain(reference);
    }
  });

  it("passes independently verified state even when the model says it fails and flags the conflict", async () => {
    const { result } = await run({ decisions: [createDecision, finish(paraphrase, false)] });
    expect(result.status, result.reason).toBe("PASS");
    expect(result.hostVerification?.[0]?.status).toBe("PASS");
    expect(result.modelAssessments?.[0]).toMatchObject({ meets: false, observedEvidence: paraphrase });
    expect(result.modelAssessmentWarnings?.join(" ")).toMatch(/disagree|conflict|contradict|differ/i);
  });

  it("blocks fabricated model evidence when no task actually appears, without fabricating a product failure", async () => {
    const fabricated = "The unique task was created and is checked in the Todo list.";
    const { result } = await run({
      decisions: [createDecision, finish(fabricated)],
      snapshots: [todoSnapshot(), todoSnapshot()],
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.hostVerification).toMatchObject([{ status: "BLOCKED" }]);
    expect(result.reason).toMatch(/missing|could not be verified/i);
    expect(result.modelAssessments?.[0]).toMatchObject({ observedEvidence: fabricated, evidenceStatus: "UNSUPPORTED", snapshotReferences: [] });
  });

  it("blocks literal matching evidence outside a listitem even after a successful browser action", async () => {
    const outside = todoSnapshot([{ text: "An unrelated task" }]).replace('heading "todos"', `heading "${taskText}"`);
    const { result } = await run({ decisions: [createDecision, finish(taskText)], snapshots: [todoSnapshot(), outside] });
    expect(result.status).toBe("BLOCKED");
    expect(result.browserActions).toMatchObject([{ toolName: "browser_navigate", status: "ok" }, { toolName: "browser_type", status: "ok" }]);
    expect(result.hostVerification).toMatchObject([{ status: "BLOCKED" }]);
    expect(result.modelAssessments?.[0]?.evidenceStatus).toBe("MATCHED_POST_ACTION");
  });

  it("blocks finish when the task exists only in the initial observation and no action has been executed", async () => {
    const { result, browser } = await run({ decisions: [finish(taskText)], snapshots: [todoSnapshot([{ text: taskText }])] });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.actionCount).toBe(0);
    expect(browser.calls).not.toContain("browser_type");
    expect(result.modelAssessments?.[0]?.evidenceStatus).toBe("UNSUPPORTED");
  });

  it.each([
    ["empty", ""],
    ["failed", { text: todoSnapshot([{ text: taskText }]), isError: true }],
    ["missing its origin", todoSnapshot([{ text: taskText }]).replace("- Page URL: https://demo.playwright.dev/todomvc/#/\n", "")],
    ["off-origin", todoSnapshot([{ text: taskText }]).replace("https://demo.playwright.dev/todomvc/#/", "https://untrusted.test/")],
  ] satisfies Array<[string, Snapshot]>)("blocks when the post-action observation is %s", async (_name, snapshot) => {
    const { result, agent } = await run({ snapshots: [todoSnapshot(), snapshot] });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(agent.calls).toBe(1);
    expect(result.hostVerification?.some(({ status }) => status === "PASS")).not.toBe(true);
  });

  it("does not authorize PASS using a recovery observation obtained after a failed tool result", async () => {
    const { result } = await run({ actionError: true });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.browserActions).toMatchObject([{ status: "ok" }, { toolName: "browser_type", status: "error" }]);
  });

  it("does not authorize PASS from a stale-reference recovery when no selected action was executed", async () => {
    const staleDecision = { ...createDecision, arguments: { target: "e999", text: taskText } };
    const { result, browser } = await run({ decisions: [staleDecision, finish()] });
    expect(result.status).toBe("BLOCKED");
    expect(result.actionCount).toBe(0);
    expect(result.recoveryCount).toBe(1);
    expect(browser.calls).not.toContain("browser_type");
  });

  it("does not reuse an earlier successful snapshot when the latest observation is a recovery snapshot", async () => {
    const staleDecision = { ...createDecision, arguments: { target: "e999", text: taskText } };
    const { result } = await run({
      decisions: [createDecision, staleDecision, finish()],
      snapshots: [todoSnapshot(), todoSnapshot([{ text: taskText }]), todoSnapshot()],
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.actionCount).toBe(1);
    expect(result.recoveryCount).toBe(1);
    expect(result.hostVerification?.some(({ status }) => status === "PASS")).not.toBe(true);
  });

  it.each([1, 2, 3])("blocks if screenshot capture claims success without creating artifact %i", async (missingScreenshotAt) => {
    const { result } = await run({ missingScreenshotAt });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/ENOENT|no such file|unavailable/i);
  });

  it("preserves an independently observed unchecked contradiction as FAIL despite paraphrased model evidence", async () => {
    const checkedScenario: PlannedScenario = {
      ...scenario,
      verificationChecks: [{ acceptanceCriterionId: "AC-01", kind: "checked", expectedVisible: ["{{uniqueTaskText}}"], expectedAbsent: [] }],
    };
    const { result } = await run({ scenario: checkedScenario, snapshots: [todoSnapshot(), todoSnapshot([{ text: taskText, state: "unchecked" }])] });
    expect(result.status, result.reason).toBe("FAIL");
    expect(result.hostVerifiedFailure).toBe(true);
    expect(result.hostVerification).toMatchObject([{ status: "FAIL", reason: expect.stringMatching(/unchecked/) }]);
    expect(result.modelAssessments?.[0]?.evidenceStatus).toBe("UNSUPPORTED");
  });

  it("keeps unknown completion state BLOCKED despite a model claim that the task is complete", async () => {
    const checkedScenario: PlannedScenario = {
      ...scenario,
      verificationChecks: [{ acceptanceCriterionId: "AC-01", kind: "checked", expectedVisible: ["{{uniqueTaskText}}"], expectedAbsent: [] }],
    };
    const { result } = await run({ scenario: checkedScenario });
    expect(result.status).toBe("BLOCKED");
    expect(result.hostVerification).toMatchObject([{ status: "BLOCKED", reason: expect.stringMatching(/No reliable checked\/unchecked/) }]);
  });

  it("retains deletion FAIL when the previously observed task remains present despite the model's success claim", async () => {
    const deletionScenario: PlannedScenario = {
      ...scenario,
      verificationChecks: [{ acceptanceCriterionId: "AC-01", kind: "absent_after_seen", expectedVisible: ["{{uniqueTaskText}}"], expectedAbsent: ["{{uniqueTaskText}}"] }],
    };
    const observed = todoSnapshot([{ text: taskText }]).replace("            - text: Delete", '            - button "Delete" [ref=e80]');
    const { result } = await run({ scenario: deletionScenario, snapshots: [todoSnapshot(), observed, observed],
      decisions: [createDecision, { kind: "action", toolName: "browser_click", arguments: { target: "e80" }, rationale: "Activate the observed removal control." }, finish()] });
    expect(result.status, result.reason).toBe("FAIL");
    expect(result.hostVerifiedFailure).toBe(true);
    expect(result.hostVerification).toMatchObject([{ status: "FAIL", reason: expect.stringMatching(/still visible/) }]);
  });

  it("retains Active-filter FAIL when a previously observed completed item remains in the selected filter", async () => {
    const filterScenario: PlannedScenario = {
      ...scenario,
      verificationChecks: [{ acceptanceCriterionId: "AC-01", kind: "filter", expectedVisible: ["{{uniqueTaskText}}-ACTIVE"], expectedAbsent: ["{{uniqueTaskText}}-COMPLETED"] }],
    };
    const items = [{ text: `${taskText}-ACTIVE`, state: "unchecked" as const }, { text: `${taskText}-COMPLETED`, state: "checked" as const }];
    const { result } = await run({ scenario: filterScenario, snapshots: [todoSnapshot(), todoSnapshot(items), todoSnapshot(items, true)],
      decisions: [createDecision, { kind: "action", toolName: "browser_click", arguments: { target: "e43" }, rationale: "Select the observed Active filter after setup." }, finish()] });
    expect(result.status, result.reason).toBe("FAIL");
    expect(result.hostVerifiedFailure).toBe(true);
    expect(result.hostVerification).toMatchObject([{ status: "FAIL", reason: expect.stringMatching(/visible completed items/) }]);
  });
});
