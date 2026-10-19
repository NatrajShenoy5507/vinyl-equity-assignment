import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/evidence/logger.js", () => ({ appendActionLog: vi.fn(async () => undefined) }));
import { executeScenario, verifyScenarioChecks, type BrowserAgent, type ExecutorLimits, type JsonAgent } from "../src/agents/executor.js";
import { appendActionLog } from "../src/evidence/logger.js";
import type { DiscoveredTool } from "../src/browser/tool-policy.js";
import type { ExecutorDecision, NormalizedIssue, PlannedScenario } from "../src/schemas.js";

const runId = "DELETE-REGRESSION";
const task = `QA-${runId}-SC-04`;
const issue: NormalizedIssue = {
  issueNumber: 1, title: "Remove a task", status: "RFQA", targetUrl: "https://demo.playwright.dev/todomvc/",
  description: "Verify the exact newly created task is removed.",
  acceptanceCriteria: [{ id: "AC-04", description: "A user can remove a task and it no longer appears in the list." }],
};
const scenario: PlannedScenario = {
  id: "SC-04", title: "Delete a task", acceptanceCriteriaIds: ["AC-04"], preconditions: [],
  steps: [{ intent: "Create a unique task and discover its removal control", expectedObservation: "The task is present before removal and absent afterward" }],
  verificationStrategy: "Verify exact task identity, removal attempt, and later absence.",
  verificationChecks: [{ acceptanceCriterionId: "AC-04", kind: "absent_after_seen", expectedVisible: ["{{uniqueTaskText}}"], expectedAbsent: ["{{uniqueTaskText}}"] }],
  relevantApplicationContext: ["The current page exposes a task textbox."], unknownControlsToDiscover: ["Discover the task's removal control from current snapshots."],
  expectedResult: "The exact task is absent after removal.",
};
const tools: DiscoveredTool[] = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_type", inputSchema: { type: "object", properties: { target: { type: "string" }, text: { type: "string" } }, required: ["target", "text"], additionalProperties: false } },
  ...["browser_hover", "browser_click"].map((name) => ({ name, inputSchema: { type: "object" as const, properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false } })),
];
const create: ExecutorDecision = { kind: "action", toolName: "browser_type", arguments: { target: "e8", text: task }, rationale: "Create the current scenario's uniquely named task." };
const hover = (target = "e19"): ExecutorDecision => ({ kind: "action", toolName: "browser_hover", arguments: { target }, rationale: "Discover the removal control from the current item." });
const remove = (target = "e33"): ExecutorDecision => ({ kind: "action", toolName: "browser_click", arguments: { target }, rationale: "Activate the current task's Delete control." });
const snapshot: ExecutorDecision = { kind: "action", toolName: "browser_snapshot", arguments: {}, rationale: "Take another snapshot to check removal." };
const finish: ExecutorDecision = { kind: "finish", assessments: [{ acceptanceCriteriaId: "AC-04", meets: true, observedEvidence: "The task has been removed.", explanation: "Model claim is advisory." }], rationale: "Request host verification of deletion." };

type Item = { text: string; ref: number };
class DeletionBrowser implements BrowserAgent {
  readonly discoveredTools = tools;
  readonly items: Item[];
  snapshotCalls = 0;
  hovered?: number;
  deleted = false;
  constructor(private readonly options: { items?: Item[]; retainTarget?: boolean; removalLabel?: string; postDeleteOrigin?: string } = {}) {
    this.items = (options.items ?? []).map((item) => ({ ...item }));
  }
  // Mirrors the saved TodoMVC trees: nested listitem/generic/checkbox/text,
  // a Delete button revealed by hover, and no list after the final deletion.
  snapshot(): string {
    return [
      "### Page", `- Page URL: ${this.deleted && this.options.postDeleteOrigin ? this.options.postDeleteOrigin : "https://demo.playwright.dev/todomvc/#/"}`,
      "- Page Title: React • TodoMVC", "- Console: 1 errors, 0 warnings", "### Snapshot", "```yaml",
      `- generic${this.deleted ? " [active]" : ""} [ref=e1]:`,
      "  - generic [ref=e5]:", '    - heading "todos" [level=1] [ref=e7]', '    - textbox "What needs to be done?" [ref=e8]',
      ...(this.items.length ? ["    - list [ref=e18]:"] : []),
      ...this.items.flatMap(({ text, ref }) => [
        `      - listitem [ref=e${ref}]:`, `        - generic [ref=e${ref + 1}]:`,
        `          - checkbox "Toggle Todo" [ref=e${ref + 2}]`, `          - generic [ref=e${ref + 3}]: ${text}`,
        this.hovered === ref ? `          - button "${this.options.removalLabel ?? "Delete"}" [ref=e${ref + 14}]: ×` : "          - text: ×",
      ]),
      "  - contentinfo [ref=e9]:", "    - paragraph [ref=e10]: Double-click to edit a todo", "```",
    ].join("\n");
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    if (name === "browser_snapshot") { this.snapshotCalls += 1; return { text: this.snapshot(), isError: false, raw: {} }; }
    if (name === "browser_navigate") return { text: "Navigation succeeded.", isError: false, raw: {} };
    if (name === "browser_type") this.items.push({ text: String(args.text), ref: 19 });
    else if (name === "browser_hover") this.hovered = Number(String(args.target).slice(1));
    else if (name === "browser_click") {
      const index = this.items.findIndex(({ ref }) => args.target === `e${ref + 14}`);
      if (index < 0) throw new Error("Unexpected removal control.");
      if (!this.options.retainTarget) this.items.splice(index, 1);
      this.deleted = true;
    } else throw new Error(`Unexpected tool ${name}`);
    return { text: "Browser action succeeded.", isError: false, raw: {} };
  }
  async screenshot(path: string) { await writeFile(path, "Mock screenshot artifact."); }
}
class DeletionAgent implements JsonAgent {
  readonly prompts: string[] = [];
  constructor(private readonly decisions: ExecutorDecision[], private readonly onRequest?: (count: number) => void) {}
  async generateJson(prompt: string) {
    this.prompts.push(prompt); this.onRequest?.(this.prompts.length);
    return this.decisions.shift() ?? finish;
  }
}
const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function run(decisions: ExecutorDecision[], options: { browser?: DeletionBrowser; limits?: Partial<ExecutorLimits>; onRequest?: (count: number) => void } = {}) {
  const screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-delete-")); temporaryDirectories.push(screenshotDirectory);
  const agent = new DeletionAgent(decisions, options.onRequest), browser = options.browser ?? new DeletionBrowser();
  const result = await executeScenario({ agent, browser, issue, scenario, runId, scenarioIndex: 1, screenshotDirectory,
    limits: { maxActions: 8, maxModelRequests: 12, maxSeconds: 20, maxRecoveryRetries: 1, ...options.limits } });
  return { result, agent, browser };
}
const events = (event: string) => vi.mocked(appendActionLog).mock.calls.map(([entry]) => entry).filter((entry) => entry.event === event);

describe("deletion evidence and snapshot-loop readiness", () => {
  it("passes create → hover → delete only after authentic exact-identity and absence proof, and records readiness", async () => {
    const { result, agent } = await run([create, hover(), remove(), finish]);
    expect(result.status, result.reason).toBe("PASS");
    expect(result.actionCount).toBe(3); expect(result.modelRequestCount).toBe(4);
    expect(agent.prompts[3]).toContain("Ready for finish; host check PASS");
    expect(agent.prompts[3]).toContain("return finish instead of requesting another snapshot");
    expect(result.hostVerification).toMatchObject([{ status: "PASS" }]);
    const evidence = result.hostVerification?.[0]?.evidence ?? [];
    expect(evidence).toHaveLength(4);
    expect(await readFile(evidence[1]!, "utf8")).toContain(task);
    expect(await readFile(evidence[3]!, "utf8")).not.toContain(task);
    expect(events("removal_attempt")).toMatchObject([{ subject: task, arguments: { target: "e33" }, status: "ok" }]);
    expect(events("verification_readiness").at(-1)).toMatchObject({ status: "ready_for_finish", pendingFinalArtifactValidation: true, hostVerification: [{ status: "PASS" }] });
  });

  it("recovers once from the failed run's repeated snapshot proposal without executing the redundant call", async () => {
    const { result, agent, browser } = await run([create, hover(), remove(), snapshot, snapshot, finish], { limits: { maxActions: 4 } });
    expect(result.status, result.reason).toBe("PASS");
    expect(result.actionCount).toBe(4); expect(result.modelRequestCount).toBe(6); expect(result.recoveryCount).toBe(1);
    expect(browser.snapshotCalls).toBe(6); // initial + 3 action observations + explicit snapshot + its automatic observation
    expect(agent.prompts[5]).toContain("Duplicate browser_snapshot against unchanged state was not executed");
    expect(agent.prompts[5]).toContain("Ready for finish; host check PASS");
    expect(events("duplicate_snapshot_deferred")).toHaveLength(1);
    expect(result.browserActions?.filter(({ toolName }) => toolName === "browser_snapshot")).toHaveLength(1);
  });

  it("keeps a successful Delete call with the target still present as host-verified FAIL", async () => {
    const { result, agent } = await run([create, hover(), remove(), finish], { browser: new DeletionBrowser({ retainTarget: true }) });
    expect(result.status, result.reason).toBe("FAIL"); expect(result.hostVerifiedFailure).toBe(true);
    expect(result.hostVerification).toMatchObject([{ status: "FAIL", reason: expect.stringContaining("still visible") }]);
    expect(agent.prompts[3]).toContain("Ready for finish; host check FAIL");
  });

  it("defers finish with missing removal-action feedback and allows the model to complete deletion", async () => {
    const { result, agent } = await run([create, hover(), finish, remove(), finish]);
    expect(result.status, result.reason).toBe("PASS"); expect(result.modelRequestCount).toBe(5);
    expect(agent.prompts[3]).toContain("No observed removal control associated with the exact task");
    expect(events("finish_deferred")).toHaveLength(1);
  });

  it("blocks when the target was never observed, even though another task was deleted", async () => {
    const browser = new DeletionBrowser({ items: [{ text: "QA-OLDER-RUN-SC-04", ref: 40 }] });
    const { result, agent } = await run([hover("e40"), remove("e54"), finish], { browser, limits: { maxModelRequests: 3 } });
    expect(result.status).toBe("BLOCKED"); expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.hostVerification?.[0]?.reason).toContain("was never observed");
    expect(agent.prompts[2]).toContain(task);
    expect(result.hostVerification?.some(({ status }) => status === "PASS")).toBe(false);
  });

  it("does not mistake deleting a wrong Todo for attempting removal of the unique target", async () => {
    const browser = new DeletionBrowser({ items: [{ text: `${task}-OLD`, ref: 40 }] });
    const { result } = await run([create, hover("e40"), remove("e54"), finish], { browser, limits: { maxModelRequests: 4 } });
    expect(result.status).toBe("BLOCKED"); expect(browser.items.map(({ text }) => text)).toEqual([task]);
    expect(result.hostVerifiedFailure).not.toBe(true);
    expect(result.hostVerification?.[0]?.reason).toContain("No observed removal control associated with the exact task");
    expect(events("removal_attempt")).toHaveLength(0);
  });

  it("can recover autonomously after deleting an unrelated Todo and then remove the correct target", async () => {
    const browser = new DeletionBrowser({ items: [{ text: "An unrelated old Todo", ref: 40 }] });
    const { result } = await run([create, hover("e40"), remove("e54"), finish, hover(), remove(), finish], { browser });
    expect(result.status, result.reason).toBe("PASS"); expect(result.actionCount).toBe(5);
    expect(events("removal_attempt")).toHaveLength(1);
  });

  it("does not accept a model-authored deletion rationale when the observed control has a different purpose", async () => {
    const { result } = await run([create, hover(), remove(), finish], { browser: new DeletionBrowser({ removalLabel: "Inspect" }), limits: { maxModelRequests: 4 } });
    expect(result.status).toBe("BLOCKED"); expect(result.hostVerification?.[0]?.reason).toContain("No observed removal control");
  });

  it("does not use an initially present matching task as proof of current-scenario creation", async () => {
    const browser = new DeletionBrowser({ items: [{ text: task, ref: 19 }] });
    const { result } = await run([hover(), remove(), finish], { browser, limits: { maxModelRequests: 3 } });
    expect(result.status).toBe("BLOCKED"); expect(result.hostVerification?.[0]?.reason).toContain("newly visible list item");
  });

  it("stops a third identical snapshot proposal after its single correction", async () => {
    const { result, browser } = await run([create, hover(), remove(), snapshot, snapshot, snapshot, finish]);
    expect(result.status).toBe("BLOCKED"); expect(result.reason).toContain("Repeated identical action");
    expect(result.modelRequestCount).toBe(6); expect(result.actionCount).toBe(4); expect(result.recoveryCount).toBe(1);
    expect(browser.snapshotCalls).toBe(6); expect(events("duplicate_action_blocked")).toHaveLength(1);
  });

  it("does not correct a repeated snapshot when recovery is disabled", async () => {
    const { result, browser } = await run([create, hover(), remove(), snapshot, snapshot], { limits: { maxRecoveryRetries: 0 } });
    expect(result.status).toBe("BLOCKED"); expect(result.reason).toContain("Repeated identical action");
    expect(result.recoveryCount).toBe(0); expect(browser.snapshotCalls).toBe(6);
  });

  it("retains the model-request bound while correcting a redundant snapshot", async () => {
    const { result, browser } = await run([create, hover(), remove(), snapshot, snapshot, finish], { limits: { maxModelRequests: 5 } });
    expect(result.status).toBe("BLOCKED"); expect(result.reason).toMatch(/request budget/);
    expect(result.modelRequestCount).toBe(5); expect(result.actionCount).toBe(4); expect(browser.snapshotCalls).toBe(6);
  });

  it("rejects a finish returned after the deadline during snapshot correction", async () => {
    let now = 1_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = await run([create, hover(), remove(), snapshot, snapshot, finish], {
      limits: { maxSeconds: 1 }, onRequest: (count) => { if (count === 6) now = 2_001; },
    });
    expect(result.status).toBe("BLOCKED"); expect(result.reason).toMatch(/time limit/); expect(result.actionCount).toBe(4);
  });

  it("rejects post-delete evidence outside the allowed origin", async () => {
    const { result, agent } = await run([create, hover(), remove(), finish], { browser: new DeletionBrowser({ postDeleteOrigin: "https://untrusted.test/" }) });
    expect(result.status).toBe("BLOCKED"); expect(result.reason).toMatch(/outside the allowed target origin/); expect(agent.prompts).toHaveLength(3);
    expect(result.hostVerification?.some(({ status }) => status === "PASS")).not.toBe(true);
  });

  it("does not use a filtered view to prove removal after an otherwise successful click", async () => {
    const { result } = await run([create, hover(), remove(), finish], { browser: new DeletionBrowser({ postDeleteOrigin: "https://demo.playwright.dev/todomvc/#/active" }), limits: { maxModelRequests: 4 } });
    expect(result.status).toBe("BLOCKED"); expect(result.hostVerification?.[0]?.reason).toMatch(/filtered view/);
  });

  it("does not mistake navigation to a different allowed-origin page for deletion proof", async () => {
    const { result } = await run([create, hover(), remove(), finish], { browser: new DeletionBrowser({ postDeleteOrigin: "https://demo.playwright.dev/another-page/#/" }), limits: { maxModelRequests: 4 } });
    expect(result.status).toBe("BLOCKED"); expect(result.hostVerification?.[0]?.reason).toMatch(/same unfiltered view/);
  });

  it("does not execute the deletion when the action budget is exhausted", async () => {
    const { result, browser } = await run([create, hover(), remove(), finish], { limits: { maxActions: 2 } });
    expect(result.status).toBe("BLOCKED"); expect(result.reason).toMatch(/action budget/);
    expect(result.actionCount).toBe(2); expect(browser.items.map(({ text }) => text)).toEqual([task]);
    expect(events("removal_attempt")).toHaveLength(0);
  });

  it("still validates exact MCP arguments after the single duplicate-snapshot correction", async () => {
    const invalid: ExecutorDecision = { ...snapshot, arguments: { filename: "not-an-allowed-snapshot-argument" } };
    const { result, browser } = await run([create, hover(), remove(), snapshot, snapshot, invalid, finish]);
    expect(result.status).toBe("BLOCKED"); expect(result.actionCount).toBe(4); expect(browser.snapshotCalls).toBe(6);
    expect(events("executor_response_invalid")).toHaveLength(1);
    expect(result.modelRequestCount).toBe(6);
  });
});

describe("strict deletion proof requirements", () => {
  it("does not allow a different absent identity than the task observed before deletion", () => {
    const checks = verifyScenarioChecks({ ...scenario, verificationChecks: [{ ...scenario.verificationChecks[0]!, expectedAbsent: ["Different task"] }] }, issue, task, []);
    expect(checks).toMatchObject([{ status: "BLOCKED", reason: expect.stringContaining("same exact current-scenario task marker") }]);
  });

  it("uses the real control reference even when the accessible name contains reference-like text", async () => {
    const { result } = await run([create, hover(), remove(), finish], { browser: new DeletionBrowser({ removalLabel: "Delete [ref=e8]" }) });
    expect(result.status, result.reason).toBe("PASS");
  });

  it("does not treat reference-like text in a control name as an attempted deletion", () => {
    const empty = new DeletionBrowser().snapshot();
    const before = new DeletionBrowser({ items: [{ text: task, ref: 19 }], removalLabel: "Delete [ref=e8]" });
    before.hovered = 19;
    const checks = verifyScenarioChecks(scenario, issue, task, [
      { stage: "initial", text: empty }, { stage: "post_action", text: before.snapshot() },
      { stage: "post_action", text: empty, action: { toolName: "browser_click", arguments: { target: "e8" } } },
    ]);
    expect(checks).toMatchObject([{ status: "BLOCKED", reason: expect.stringContaining("No observed removal control") }]);
  });
});
