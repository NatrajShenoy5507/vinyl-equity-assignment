import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/evidence/logger.js", () => ({ appendActionLog: vi.fn(async () => undefined) }));

import { executeScenario, type JsonAgent } from "../src/agents/executor.js";
import { revalidateScenario, type RevalidationBrowser } from "../src/agents/revalidator.js";
import type { NormalizedIssue, PlannedScenario, ScenarioResult } from "../src/schemas.js";
import type { DiscoveredTool } from "../src/browser/tool-policy.js";

const issue: NormalizedIssue = {
  issueNumber: 1,
  title: "Todo",
  status: "RFQA",
  targetUrl: "https://demo.test/",
  description: "Story",
  acceptanceCriteria: [{ id: "AC-01", description: "A task can be completed." }],
};

const scenario: PlannedScenario = {
  id: "SC-01",
  title: "Complete a task",
  acceptanceCriteriaIds: ["AC-01"],
  preconditions: [],
  steps: [{ intent: "Complete the task.", expectedObservation: "The task is checked." }],
  verificationStrategy: "Verify the task checkbox state in a fresh snapshot.",
  verificationChecks: [{
    acceptanceCriterionId: "AC-01",
    kind: "checked",
    expectedVisible: ["{{uniqueTaskText}}"],
    expectedAbsent: [],
  }],
  relevantApplicationContext: ["Observed task list"],
  unknownControlsToDiscover: [],
  expectedResult: "The task is checked.",
};

const tools: DiscoveredTool[] = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", inputSchema: { type: "object" } },
  { name: "browser_click", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "browser_take_screenshot", inputSchema: { type: "object" } },
];

class FakeAgent implements JsonAgent {
  calls = 0;
  constructor(private readonly responses: Array<unknown | ((prompt: string) => unknown)>) {}
  async generateJson(prompt: string): Promise<unknown> {
    this.calls += 1;
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("Fake agent ran out of responses.");
    return typeof response === "function" ? response(prompt) : response;
  }
}

class FakeBrowser implements RevalidationBrowser {
  readonly discoveredTools = tools;
  readonly calls: string[] = [];
  closed = false;
  constructor(private readonly snapshots: string[]) {}
  async connect(): Promise<DiscoveredTool[]> { return tools; }
  async call(name: string): Promise<{ text: string; isError: boolean; raw: unknown }> {
    this.calls.push(name);
    if (name === "browser_snapshot") return { text: this.snapshots.shift() ?? "", isError: false, raw: {} };
    return { text: "ok", isError: false, raw: {} };
  }
  async screenshot(filePath: string): Promise<void> {
    await writeFile(filePath, "mock browser screenshot");
  }
  async close(): Promise<void> { this.closed = true; }
}

let screenshotDirectory = "";
afterEach(async () => {
  if (screenshotDirectory) await rm(screenshotDirectory, { recursive: true, force: true });
  screenshotDirectory = "";
});

const snapshot = (text: string, state: "checked" | "unchecked") =>
  `- Page URL: https://demo.test/\n- listitem:\n  checkbox "Complete" [ref=e1] [${state}]\n  text: ${text}`;
const action = {
  kind: "action",
  toolName: "browser_click",
  arguments: { target: "e1" },
  rationale: "Toggle the observed task control.",
};
const finish = (text: string) => ({
  kind: "finish",
  assessments: [{ acceptanceCriteriaId: "AC-01", meets: true, observedEvidence: text, explanation: "The task state was observed." }],
  rationale: "Evaluate the fresh browser observation.",
});
const finishUsingPromptTask = (prompt: string) => {
  const taskText = prompt.match(/Use the unique task text "([^"]+)"/)?.[1];
  if (!taskText) throw new Error("Executor prompt omitted its unique task marker.");
  return finish(taskText);
};

async function makeOriginalFailure(agent: FakeAgent, runId = `ORIGINAL-${Date.now()}-${Math.random()}`) {
  screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-revalidation-"));
  const taskText = `QA-${runId}-${scenario.id}`;
  const browser = new FakeBrowser([snapshot(taskText, "unchecked"), snapshot(taskText, "unchecked")]);
  const result = await executeScenario({
    agent,
    browser,
    issue,
    scenario,
    runId,
    scenarioIndex: 1,
    screenshotDirectory,
    limits: { maxActions: 5, maxModelRequests: 5, maxSeconds: 10, maxRecoveryRetries: 0 },
  });
  await browser.close();
  expect(result.status).toBe("FAIL");
  expect(result.hostVerifiedFailure).toBe(true);
  return { runId, result, originalBrowser: browser };
}

describe("conditional scenario revalidation", () => {
  it("revalidates a host-verified failure once and confirms a repeat failure without replacing original evidence", async () => {
    const runId = "ORIGINAL-CONFIRMED";
    const agent = new FakeAgent([action, finish(`QA-${runId}-${scenario.id}`), action, finishUsingPromptTask]);
    const { result, originalBrowser } = await makeOriginalFailure(agent, runId);
    const originalEvidence = [...result.evidence];
    let retryBrowser: FakeBrowser | undefined;
    const revalidated = await revalidateScenario({
      agent,
      createBrowser: (retryRunId) => {
        retryBrowser = new FakeBrowser([
          snapshot(`QA-${retryRunId}-${scenario.id}`, "unchecked"),
          snapshot(`QA-${retryRunId}-${scenario.id}`, "unchecked"),
        ]);
        return retryBrowser;
      },
      issue,
      scenario,
      originalResult: result,
      originalRunId: runId,
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 5, maxModelRequests: 5, maxSeconds: 10, maxRecoveryRetries: 0 },
    });

    expect(revalidated.status).toBe("FAIL");
    expect(revalidated.revalidation).toMatchObject({
      attemptCount: 1,
      classification: "CONFIRMED_FAILURE",
      originalFailureReason: result.reason,
      originalResult: result,
      attemptResult: { status: "FAIL", actionCount: 1, recoveryCount: 0 },
    });
    expect(revalidated.evidence).toEqual(originalEvidence);
    expect(revalidated.revalidation?.attemptResult.evidence).not.toEqual(originalEvidence);
    expect(retryBrowser).not.toBe(originalBrowser);
    expect(originalBrowser.closed).toBe(true);
    expect(retryBrowser?.closed).toBe(true);
    expect(agent.calls).toBe(4);
  });

  it("classifies a retry PASS as inconsistent while preserving the original FAIL", async () => {
    const runId = "ORIGINAL-FLAKY";
    const agent = new FakeAgent([action, finish(`QA-${runId}-${scenario.id}`), action, finishUsingPromptTask]);
    const { result } = await makeOriginalFailure(agent, runId);
    const retried = await revalidateScenario({
      agent,
      createBrowser: (retryRunId) => new FakeBrowser([
        snapshot(`QA-${retryRunId}-${scenario.id}`, "unchecked"),
        snapshot(`QA-${retryRunId}-${scenario.id}`, "checked"),
      ]),
      issue,
      scenario,
      originalResult: result,
      originalRunId: runId,
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 5, maxModelRequests: 5, maxSeconds: 10, maxRecoveryRetries: 0 },
    });
    expect(retried.status).toBe("FAIL");
    expect(retried.revalidation?.classification).toBe("FLAKY_OR_INCONSISTENT");
    expect(retried.revalidation?.attemptResult.status).toBe("PASS");
    expect(retried.revalidation?.attemptCount).toBe(1);
  });

  it("classifies Gemini quota failure during revalidation as inconclusive without retrying again", async () => {
    const runId = "ORIGINAL-QUOTA";
    const agent = new FakeAgent([
      action,
      finish(`QA-${runId}-${scenario.id}`),
      Object.assign(new Error("Gemini HTTP 429 RESOURCE_EXHAUSTED"), { status: 429 }),
    ]);
    const { result } = await makeOriginalFailure(agent, runId);
    let browserCreations = 0;
    const retried = await revalidateScenario({
      agent,
      createBrowser: (retryRunId) => {
        browserCreations += 1;
        return new FakeBrowser([
          snapshot(`QA-${retryRunId}-${scenario.id}`, "unchecked"),
          snapshot(`QA-${retryRunId}-${scenario.id}`, "unchecked"),
        ]);
      },
      issue,
      scenario,
      originalResult: result,
      originalRunId: runId,
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 5, maxModelRequests: 5, maxSeconds: 10, maxRecoveryRetries: 0 },
    });
    expect(retried.status).toBe("FAIL");
    expect(retried.revalidation?.classification).toBe("REVALIDATION_INCONCLUSIVE");
    expect(retried.revalidation?.attemptResult.status).toBe("BLOCKED");
    expect(retried.revalidation?.attemptResult.reason).toContain("429");
    expect(browserCreations).toBe(1);
    expect(agent.calls).toBe(3);
  });

  it.each(["PASS", "BLOCKED", "SKIPPED"] as const)("does not revalidate an original %s result", async (status) => {
    const original: ScenarioResult = {
      scenarioId: scenario.id,
      title: scenario.title,
      acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
      status,
      expected: scenario.expectedResult,
      observed: "No functional failure.",
      reason: "Not eligible for revalidation.",
      evidence: [],
      actionCount: 0,
      recoveryCount: 0,
    };
    const agent = new FakeAgent([]);
    let browserCreations = 0;
    const result = await revalidateScenario({
      agent,
      createBrowser: () => {
        browserCreations += 1;
        return new FakeBrowser([]);
      },
      issue,
      scenario,
      originalResult: original,
      originalRunId: `NO-RETRY-${status}`,
      scenarioIndex: 1,
      screenshotDirectory: "unused",
      limits: { maxActions: 5, maxSeconds: 10, maxRecoveryRetries: 0 },
    });
    expect(result).toBe(original);
    expect(browserCreations).toBe(0);
    expect(agent.calls).toBe(0);
  });

  it("does not revalidate an unverified FAIL and never attempts the same failed scenario twice", async () => {
    const nonHostFailure: ScenarioResult = {
      scenarioId: scenario.id,
      title: scenario.title,
      acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
      status: "FAIL",
      expected: scenario.expectedResult,
      observed: "Unverified failure.",
      reason: "No host verification provenance.",
      evidence: [],
      actionCount: 0,
      recoveryCount: 0,
    };
    const agent = new FakeAgent([]);
    let browserCreations = 0;
    const baseInput = {
      agent,
      createBrowser: () => {
        browserCreations += 1;
        return new FakeBrowser([]);
      },
      issue,
      scenario,
      scenarioIndex: 1,
      screenshotDirectory: "unused",
      limits: { maxActions: 5, maxSeconds: 10, maxRecoveryRetries: 0 },
    };
    expect(await revalidateScenario({
      ...baseInput,
      originalResult: nonHostFailure,
      originalRunId: "UNVERIFIED-FAIL",
    })).toBe(nonHostFailure);

    const runId = "ORIGINAL-ONE-ATTEMPT";
    const retryAgent = new FakeAgent([action, finish(`QA-${runId}-${scenario.id}`), action, finishUsingPromptTask]);
    const { result } = await makeOriginalFailure(retryAgent, runId);
    const input = {
      ...baseInput,
      agent: retryAgent,
      originalResult: result,
      originalRunId: runId,
      createBrowser: (retryRunId: string) => {
        browserCreations += 1;
        return new FakeBrowser([
          snapshot(`QA-${retryRunId}-${scenario.id}`, "unchecked"),
          snapshot(`QA-${retryRunId}-${scenario.id}`, "unchecked"),
        ]);
      },
      screenshotDirectory,
    };
    const first = await revalidateScenario(input);
    const second = await revalidateScenario(input);
    expect(first.revalidation?.attemptCount).toBe(1);
    expect(second).toBe(result);
    expect(browserCreations).toBe(1);
    expect(retryAgent.calls).toBe(4);
  });

  it("does not repeat destructive scenarios", async () => {
    const destructiveScenario: PlannedScenario = {
      ...scenario,
      title: "Delete the account",
      verificationChecks: [{
        acceptanceCriterionId: "AC-01",
        kind: "absent_after_seen",
        expectedVisible: ["{{uniqueTaskText}}"],
        expectedAbsent: ["{{uniqueTaskText}}"],
      }],
    };
    const original: ScenarioResult = {
      scenarioId: destructiveScenario.id,
      title: destructiveScenario.title,
      acceptanceCriteriaIds: destructiveScenario.acceptanceCriteriaIds,
      status: "FAIL",
      hostVerifiedFailure: true,
      expected: destructiveScenario.expectedResult,
      observed: "The account was still observed.",
      reason: "The host verifier observed a failure.",
      evidence: ["original.png"],
      actionCount: 1,
      recoveryCount: 0,
    };
    const agent = new FakeAgent([]);
    let browserCreations = 0;
    const result = await revalidateScenario({
      agent,
      createBrowser: () => {
        browserCreations += 1;
        return new FakeBrowser([]);
      },
      issue,
      scenario: destructiveScenario,
      originalResult: original,
      originalRunId: "DESTRUCTIVE",
      scenarioIndex: 1,
      screenshotDirectory: "unused",
      limits: { maxActions: 5, maxSeconds: 10, maxRecoveryRetries: 0 },
    });
    expect(result).toBe(original);
    expect(browserCreations).toBe(0);
    expect(agent.calls).toBe(0);
  });
});
