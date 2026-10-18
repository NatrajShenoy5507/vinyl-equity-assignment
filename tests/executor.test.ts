import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/evidence/logger.js", () => ({ appendActionLog: vi.fn(async () => undefined) }));

import { executeScenario, type BrowserAgent, type JsonAgent } from "../src/agents/executor.js";
import type { NormalizedIssue, PlannedScenario } from "../src/schemas.js";
import type { DiscoveredTool } from "../src/browser/tool-policy.js";

const issue: NormalizedIssue = {
  issueNumber: 1,
  title: "Todo",
  status: "RFQA",
  targetUrl: "https://demo.test/",
  description: "Story",
  acceptanceCriteria: [{ id: "AC-01", description: "A new task appears." }],
};
const scenario: PlannedScenario = {
  id: "SC-01",
  title: "Create task",
  acceptanceCriteriaIds: ["AC-01"],
  preconditions: [],
  steps: [{ intent: "Create a new task", expectedObservation: "The task appears" }],
  expectedResult: "The unique task is visible.",
};
const tools: DiscoveredTool[] = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", inputSchema: { type: "object" } },
  { name: "browser_click", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "browser_take_screenshot", inputSchema: { type: "object" } },
];

class FakeAgent implements JsonAgent {
  constructor(private readonly decisions: unknown[]) {}
  async generateJson(): Promise<unknown> {
    const decision = this.decisions.shift();
    if (decision === undefined) throw new Error("Fake agent ran out of decisions.");
    return decision;
  }
}

class FakeBrowser implements BrowserAgent {
  readonly discoveredTools = tools;
  readonly calls: string[] = [];

  constructor(private readonly snapshots: string[], private readonly results: Array<{ text: string; isError: boolean }> = []) {}

  async call(name: string): Promise<{ text: string; isError: boolean; raw: unknown }> {
    this.calls.push(name);
    if (name === "browser_snapshot") return { text: this.snapshots.shift() ?? "", isError: false, raw: {} };
    if (name === "browser_navigate") return { text: "Navigated", isError: false, raw: {} };
    const result = this.results.shift() ?? { text: "Clicked", isError: false };
    return { ...result, raw: {} };
  }

  async screenshot(filePath: string): Promise<void> {
    await writeFile(filePath, "fake screenshot from a unit-test browser");
  }
}

let screenshotDirectory = "";
afterEach(async () => {
  if (screenshotDirectory) await rm(screenshotDirectory, { recursive: true, force: true });
  screenshotDirectory = "";
});

async function run(decisions: unknown[], snapshots: string[], options: {
  results?: Array<{ text: string; isError: boolean }>;
  maxActions?: number;
  maxSeconds?: number;
  maxRecoveryRetries?: number;
} = {}) {
  screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
  return executeScenario({
    agent: new FakeAgent(decisions),
    browser: new FakeBrowser(snapshots, options.results),
    issue,
    scenario,
    runId: "TEST",
    scenarioIndex: 1,
    screenshotDirectory,
    limits: {
      maxActions: options.maxActions ?? 10,
      maxSeconds: options.maxSeconds ?? 10,
      maxRecoveryRetries: options.maxRecoveryRetries ?? 1,
    },
  });
}

const passDecision = (evidence: string) => ({
  kind: "finish",
  assessments: [{ acceptanceCriteriaId: "AC-01", meets: true, observedEvidence: evidence, explanation: "The item appears." }],
  rationale: "Observed the item after navigation.",
});
const clickDecision = { kind: "action", toolName: "browser_click", arguments: { target: "e1" }, rationale: "Use the observed control." };
const pageSnapshot = (content: string, url = "https://demo.test/", reference = "e1") => `- Page URL: ${url}\n- textbox [ref=${reference}]\n${content}`;

describe("autonomous executor evidence gates", () => {
  it("passes only when a post-navigation browser observation supports the AC", async () => {
    const result = await run([passDecision("QA-TEST-SC-01")], [pageSnapshot("Todo list: QA-TEST-SC-01")]);
    expect(result.status).toBe("PASS");
    expect(result.evidence).toHaveLength(2);
  });

  it("classifies an observed contradiction as FAIL", async () => {
    const result = await run([{
      kind: "finish",
      assessments: [{ acceptanceCriteriaId: "AC-01", meets: false, observedEvidence: "Todo list is empty", explanation: "The new item is absent." }],
      rationale: "The state contradicts the criterion.",
    }], [pageSnapshot("Todo list is empty")]);
    expect(result.status).toBe("FAIL");
  });

  it("rejects fabricated PASS evidence", async () => {
    const result = await run([passDecision("I saw a task that was not in the snapshot.")], [pageSnapshot("Todo list")]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/does not exactly match/);
  });

  it("stops at the action budget", async () => {
    const result = await run([clickDecision, clickDecision], [pageSnapshot("Initial state"), pageSnapshot("After first action")], { maxActions: 1 });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/action budget/);
  });

  it("stops a repeated action when the snapshot has not changed", async () => {
    const result = await run([clickDecision, clickDecision], [pageSnapshot("Same state"), pageSnapshot("Same state")]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/unchanged snapshot/);
  });

  it("allows only one fresh-snapshot recovery after a failed interaction", async () => {
    const result = await run(
      [clickDecision, passDecision("fresh state after recovery")],
      [pageSnapshot("initial state"), pageSnapshot("fresh state after recovery")],
      { results: [{ text: "Stale reference", isError: true }] },
    );
    expect(result.status).toBe("PASS");
    expect(result.recoveryCount).toBe(1);
  });

  it("classifies an unpermitted model tool request as BLOCKED", async () => {
    const result = await run([{
      kind: "action", toolName: "browser_run_code_unsafe", arguments: {}, rationale: "Attempt unsafe execution.",
    }], [pageSnapshot("Initial state")]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/not permitted/);
  });

  it("blocks when the per-scenario time budget is exhausted", async () => {
    const result = await run([passDecision("state")], [pageSnapshot("state")], { maxSeconds: 0.0001 });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/time limit|action budget/);
  });

  it("blocks an off-origin redirect observed after navigation", async () => {
    const result = await run([passDecision("untrusted")], [pageSnapshot("untrusted", "https://other.test/")]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/outside the allowed target origin/);
  });

  it("refreshes once and blocks a reference that is absent from the latest snapshot", async () => {
    const result = await run([clickDecision, clickDecision], [pageSnapshot("initial", "https://demo.test/", "e8"), pageSnapshot("refreshed", "https://demo.test/", "e8")]);
    expect(result.status).toBe("BLOCKED");
    expect(result.recoveryCount).toBe(1);
    expect(result.reason).toMatch(/not present in the latest accessibility snapshot/);
  });
});
