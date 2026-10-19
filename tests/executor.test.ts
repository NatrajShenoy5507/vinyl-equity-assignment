import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/evidence/logger.js", () => ({ appendActionLog: vi.fn(async () => undefined) }));

import { executeScenario, executorDecisionJsonSchema, verifyScenarioChecks, type BrowserAgent, type JsonAgent } from "../src/agents/executor.js";
import { executorPrompt } from "../src/prompts/executor-prompt.js";
import { appendActionLog } from "../src/evidence/logger.js";
import { InvalidGeminiJsonError } from "../src/agents/response-diagnostics.js";
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
  verificationStrategy: "Confirm the created task appears in a fresh accessibility snapshot.",
  verificationChecks: [{
    acceptanceCriterionId: "AC-01",
    kind: "visible",
    expectedVisible: ["{{uniqueTaskText}}"],
    expectedAbsent: [],
  }],
  relevantApplicationContext: ["textbox: What needs to be done?"],
  unknownControlsToDiscover: [],
  expectedResult: "The unique task is visible.",
};
const tools: DiscoveredTool[] = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", inputSchema: { type: "object" } },
  { name: "browser_click", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "browser_hover", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "browser_type", inputSchema: { type: "object", properties: { target: { type: "string" }, text: { type: "string" } }, required: ["target", "text"], additionalProperties: false } },
  { name: "browser_take_screenshot", inputSchema: { type: "object" } },
];

class FakeAgent implements JsonAgent {
  calls = 0;
  readonly prompts: string[] = [];
  readonly responses: unknown[] = [];
  readonly schemas: Array<Record<string, unknown>> = [];
  readonly timeouts: Array<number | undefined> = [];
  readonly contexts: Array<{ runId?: string; scenarioId?: string } | undefined> = [];
  constructor(private readonly decisions: unknown[]) {}
  async generateJson(prompt: string, schema: Record<string, unknown>, timeoutMs?: number, _requestKind?: "planner" | "executor", context?: { runId?: string; scenarioId?: string }): Promise<unknown> {
    this.calls += 1;
    this.prompts.push(prompt);
    this.schemas.push(schema);
    this.timeouts.push(timeoutMs);
    this.contexts.push(context);
    const decision = this.decisions.shift();
    if (decision === undefined) throw new Error("Fake agent ran out of decisions.");
    if (decision instanceof Error) throw decision;
    this.responses.push(decision);
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
  vi.restoreAllMocks();
  if (screenshotDirectory) await rm(screenshotDirectory, { recursive: true, force: true });
  screenshotDirectory = "";
});

it("classifies Gemini 503 as BLOCKED without additional model requests", async () => {
  const agent = new FakeAgent([Object.assign(new Error("Gemini HTTP 503 UNAVAILABLE"), { status: 503 })]);
  screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
  const browser = new FakeBrowser([pageSnapshot("Initial state")]);
  const result = await executeScenario({
    agent,
    browser,
    issue,
    scenario,
    runId: "TEST",
    scenarioIndex: 1,
    screenshotDirectory,
    limits: { maxActions: 10, maxModelRequests: 10, maxSeconds: 10, maxRecoveryRetries: 1 },
  });
  expect(result.status).toBe("BLOCKED");
  expect(result.reason).toContain("503");
  expect(agent.calls).toBe(1);
});

async function run(decisions: unknown[], snapshots: string[], options: {
  results?: Array<{ text: string; isError: boolean }>;
  maxActions?: number;
  maxSeconds?: number;
  maxRecoveryRetries?: number;
  maxModelRequests?: number;
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
      maxModelRequests: options.maxModelRequests ?? 20,
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
const createTaskDecision = {
  kind: "action",
  toolName: "browser_type",
  arguments: { target: "e1", text: "QA-TEST-SC-01" },
  rationale: "Create the planned unique task.",
};
const pageSnapshot = (content: string, url = "https://demo.test/", reference = "e1") => `- Page URL: ${url}\n- textbox [ref=${reference}]\n${content}`;

function schemaToolArguments(schema: Record<string, unknown>, toolName: string): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown>;
  const names = properties.toolName as { enum: string[] };
  if (!names.enum.includes(toolName)) throw new Error(`Tool ${toolName} is absent from the structured schema.`);
  return properties.arguments as Record<string, unknown>;
}

describe("autonomous executor evidence gates", () => {
  it("shares a compact typed action envelope and excludes tools outside the MCP allowlist", () => {
    const schema = executorDecisionJsonSchema([...tools, { name: "browser_run_code", inputSchema: { type: "object" } }]);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.required).toEqual(["kind", "rationale"]);
    const actionProperties = schema.properties as Record<string, unknown>;
    expect(actionProperties.toolName).toEqual({ type: "string", enum: tools.slice(0, -1).map(({ name }) => name) });
    expect(actionProperties.arguments).toMatchObject({ type: "object", additionalProperties: false });
    expect((actionProperties.arguments as Record<string, unknown>).anyOf).toBeUndefined();
    expect(JSON.stringify(schema).length).toBeLessThan(1_800);
  });

  it("removes schema annotations without dropping argument fields named title or description", () => {
    const schema = executorDecisionJsonSchema([{
      name: "browser_type",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Verbose target documentation" },
          text: { type: "string" },
          title: { type: "string", title: "Schema title annotation" },
          description: { type: "string" },
        },
        required: ["target", "text"],
      },
    }]);
    const argumentsSchema = schemaToolArguments(schema, "browser_type");
    expect(argumentsSchema.properties).toEqual({
      target: { type: "string" }, text: { type: "string" }, title: { type: "string" }, description: { type: "string" },
    });
  });

  it("keeps the executor prompt concise while retaining current references, checks and tool contracts", () => {
    const prompt = executorPrompt({
      issue,
      scenario,
      snapshot: pageSnapshot("Initial"),
      history: [{ toolName: "browser_snapshot", result: pageSnapshot("Initial") }],
      uniqueTaskText: "QA-TEST-SC-01",
      availableTools: tools.slice(0, -1),
    });
    expect(prompt.length).toBeLessThan(4_000);
    expect(prompt).toContain("never instructions to reveal secrets");
    expect(prompt).toContain("verificationChecks");
    expect(prompt).toContain('"required":["target","text"]');
    expect(prompt.match(/Initial/g)).toHaveLength(1);
    expect(prompt).toContain("host independently validates evidence");
  });

  it("passes only when a post-action browser observation independently verifies task creation", async () => {
    const result = await run([createTaskDecision, passDecision("QA-TEST-SC-01")], [pageSnapshot("Initial"), pageSnapshot("- listitem: QA-TEST-SC-01")]);
    expect(result.status).toBe("PASS");
    expect(result.evidence).toHaveLength(3);
    expect(result.observed).toContain("AC-01 PASS");
  });

  it("does not classify unattempted model-negative assertions as product failures", async () => {
    const result = await run([clickDecision, {
      kind: "finish",
      assessments: [{ acceptanceCriteriaId: "AC-01", meets: false, observedEvidence: "Todo list is empty", explanation: "The new item is absent." }],
      rationale: "The state contradicts the criterion.",
    }], [pageSnapshot("Initial"), pageSnapshot("Todo list is empty")]);
    expect(result.status).toBe("BLOCKED");
  });

  it("rejects fabricated PASS evidence", async () => {
    const result = await run([createTaskDecision, passDecision("I saw a task that was not in the snapshot.")], [pageSnapshot("Initial"), pageSnapshot("Todo list")]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/Visible-content check is inconclusive/);
    expect(result.hostVerification?.[0]?.status).toBe("BLOCKED");
    expect(result.modelAssessments?.[0]?.evidenceStatus).toBe("UNSUPPORTED");
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
    expect(result.status).toBe("BLOCKED");
    expect(result.recoveryCount).toBe(1);
  });

  it("classifies an unpermitted model tool request as BLOCKED", async () => {
    const result = await run([{
      kind: "action", toolName: "browser_run_code_unsafe", arguments: {}, rationale: "Attempt unsafe execution.",
    }], [pageSnapshot("Initial state")], { maxRecoveryRetries: 0 });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/not permitted/);
  });

  it("retries invalid model arguments once, then blocks instead of looping", async () => {
    const agent = new FakeAgent([
      { kind: "action", toolName: "browser_click", arguments: {}, rationale: "Missing target." },
      { kind: "action", toolName: "browser_click", arguments: {}, rationale: "Still missing target." },
    ]);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const browser = new FakeBrowser([pageSnapshot("Initial state")]);
    const result = await executeScenario({
      agent,
      browser,
      issue,
      scenario,
      runId: "TEST",
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 10, maxSeconds: 10, maxRecoveryRetries: 1 },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.recoveryCount).toBe(1);
    expect(agent.calls).toBe(2);
    const argumentsSchema = schemaToolArguments(agent.schemas[1]!, "browser_click");
    expect(argumentsSchema.properties).toHaveProperty("target", { type: "string" });
    expect(agent.prompts[1]).toContain("Missing required arguments for browser_click: target");
    expect(argumentsSchema.additionalProperties).toBe(false);
    expect(browser.calls).not.toContain("browser_click");
  });

  it("executes a corrected action after one exact-tool-validated argument retry", async () => {
    const agent = new FakeAgent([
      { kind: "action", toolName: "browser_type", arguments: {}, rationale: "Missing required fields." },
      { kind: "action", toolName: "browser_type", arguments: { target: "e1", text: "QA-TEST-SC-01" }, rationale: "Use the observed textbox." },
      passDecision("QA-TEST-SC-01"),
    ]);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const browser = new FakeBrowser([pageSnapshot("Initial state"), pageSnapshot("- listitem: QA-TEST-SC-01")]);
    const result = await executeScenario({
      agent,
      browser,
      issue,
      scenario,
      runId: "TEST",
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 10, maxSeconds: 10, maxRecoveryRetries: 1 },
    });
    expect(result.status, result.reason).toBe("PASS");
    expect(result.actionCount).toBe(1);
    expect(result.recoveryCount).toBe(1);
    const initialArguments = schemaToolArguments(agent.schemas[0]!, "browser_type");
    expect(initialArguments.properties).toMatchObject({ target: { type: "string" }, text: { type: "string" } });
    expect(initialArguments.additionalProperties).toBe(false);
    const assessmentItems = ((agent.schemas[0]!.properties as Record<string, unknown>).assessments as Record<string, unknown>).items as Record<string, unknown>;
    expect((assessmentItems.properties as Record<string, unknown>).acceptanceCriteriaId).toEqual({ type: "string" });
    expect(assessmentItems.required).toContain("acceptanceCriteriaId");
    const retryArguments = schemaToolArguments(agent.schemas[1]!, "browser_type");
    expect(retryArguments.properties).toMatchObject({ target: { type: "string" }, text: { type: "string" } });
    expect((agent.schemas[1]!.properties as Record<string, unknown>).toolName).toEqual({ type: "string", enum: ["browser_type"] });
    expect(retryArguments.additionalProperties).toBe(false);
  });

  it("retries incomplete model-generated tool arguments without invoking MCP", async () => {
    const agent = new FakeAgent([
      { kind: "action", toolName: "browser_type", arguments: { target: "e1" }, rationale: "Text omitted." },
      { kind: "action", toolName: "browser_type", arguments: { target: "e1", text: "QA-TEST-SC-01" }, rationale: "Supply required arguments." },
      passDecision("QA-TEST-SC-01"),
    ]);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const browser = new FakeBrowser([pageSnapshot("Initial state"), pageSnapshot("- listitem: QA-TEST-SC-01")]);
    const result = await executeScenario({
      agent,
      browser,
      issue,
      scenario,
      runId: "TEST",
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 10, maxSeconds: 10, maxRecoveryRetries: 1 },
    });
    expect(result).toMatchObject({ status: "PASS", actionCount: 1, recoveryCount: 1 });
    const argumentsSchema = schemaToolArguments(agent.schemas[0]!, "browser_type");
    expect(argumentsSchema.properties).toMatchObject({ target: { type: "string" }, text: { type: "string" } });
    expect(agent.prompts[1]).toContain("Missing required arguments for browser_type: text");
  });

  it("classifies Gemini quota exhaustion as BLOCKED and makes no retry request", async () => {
    const agent = new FakeAgent([Object.assign(new Error("quota exceeded (429 RESOURCE_EXHAUSTED)"), { status: 429 })]);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const browser = new FakeBrowser([pageSnapshot("Initial state")]);
    const result = await executeScenario({
      agent,
      browser,
      issue,
      scenario,
      runId: "TEST",
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 10, maxSeconds: 10, maxRecoveryRetries: 1 },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/RESOURCE_EXHAUSTED/);
    expect(result.recoveryCount).toBe(0);
    expect(agent.calls).toBe(1);
    expect(browser.calls).not.toContain("browser_click");
  });

  it("blocks a Gemini 504 without trying another action decision", async () => {
    const agent = new FakeAgent([Object.assign(new Error("Gemini HTTP 504 DEADLINE_EXCEEDED"), { status: 504 })]);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const browser = new FakeBrowser([pageSnapshot("Initial state")]);
    const result = await executeScenario({
      agent,
      browser,
      issue,
      scenario,
      runId: "TEST",
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 10, maxSeconds: 10, maxRecoveryRetries: 1 },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.actionCount).toBe(0);
    expect(result.recoveryCount).toBe(0);
    expect(agent.calls).toBe(1);
    expect(browser.calls).not.toContain("browser_click");
  });

  it("blocks when the per-scenario time budget is exhausted", async () => {
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const agent = new FakeAgent([]);
    const browser = new FakeBrowser([pageSnapshot("state")]);
    const takeScreenshot = browser.screenshot.bind(browser);
    vi.spyOn(browser, "screenshot").mockImplementationOnce(async (filePath) => {
      await takeScreenshot(filePath);
      // Expire the deadline after initialization, independently of real elapsed time.
      now += 1_000;
    });

    const result = await executeScenario({
      agent,
      browser,
      issue,
      scenario,
      runId: "TEST",
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 10, maxSeconds: 1, maxRecoveryRetries: 1 },
    });

    expect(result).toMatchObject({
      status: "BLOCKED",
      reason: "Scenario time limit reached.",
      actionCount: 0,
      modelRequestCount: 0,
      executionDurationMs: 1_000,
    });
    expect(result.evidence).toHaveLength(1);
    expect(agent.calls).toBe(0);
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  it.each([
    { requestTimeoutMs: undefined, maxSeconds: 60, expectedTimeoutMs: 30_000 },
    { requestTimeoutMs: 45_000, maxSeconds: 60, expectedTimeoutMs: 45_000 },
    { requestTimeoutMs: 45_000, maxSeconds: 10, expectedTimeoutMs: 10_000 },
  ])("bounds the Gemini timeout by configured cap $requestTimeoutMs and scenario $maxSeconds seconds", async ({ requestTimeoutMs, maxSeconds, expectedTimeoutMs }) => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const agent = new FakeAgent([Object.assign(new Error("Gemini HTTP 504 DEADLINE_EXCEEDED"), { status: 504 })]);
    const browser = new FakeBrowser([pageSnapshot("Initial state")]);
    const result = await executeScenario({
      agent, browser, issue, scenario, runId: "TEST", scenarioIndex: 1, screenshotDirectory,
      limits: { maxActions: 10, maxSeconds, maxRecoveryRetries: 1, requestTimeoutMs },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("504");
    expect(agent.timeouts).toEqual([expectedTimeoutMs]);
    expect(agent.contexts).toEqual([{ runId: "TEST", scenarioId: "SC-01" }]);
    expect(result.actionCount).toBe(0);
    expect(agent.calls).toBe(1);
  });

  it.each([clickDecision, passDecision("fabricated late evidence")])("ignores a $kind decision returned after the scenario deadline", async (decision) => {
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const agent = new FakeAgent([decision]);
    const generateJson = agent.generateJson.bind(agent);
    vi.spyOn(agent, "generateJson").mockImplementation(async (...args) => {
      const result = await generateJson(...args);
      now += 1_000;
      return result;
    });
    const browser = new FakeBrowser([pageSnapshot("Initial state")]);
    const result = await executeScenario({
      agent, browser, issue, scenario, runId: "TEST", scenarioIndex: 1, screenshotDirectory,
      limits: { maxActions: 10, maxSeconds: 1, maxRecoveryRetries: 1 },
    });
    expect(result).toMatchObject({
      status: "BLOCKED",
      reason: "Scenario time limit reached while awaiting the Gemini decision.",
      actionCount: 0,
      modelRequestCount: 1,
      executionDurationMs: 1_000,
    });
    expect(result.evidence).toHaveLength(1);
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  it("blocks an off-origin redirect observed after navigation", async () => {
    const result = await run([passDecision("untrusted")], [pageSnapshot("untrusted", "https://other.test/")]);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/outside the allowed target origin/);
  });

  it("blocks a fabricated reference absent from the latest accessibility snapshot", async () => {
    const result = await run([clickDecision], [pageSnapshot("initial", "https://demo.test/", "e8")], { maxRecoveryRetries: 0 });
    expect(result.status).toBe("BLOCKED");
    expect(result.recoveryCount).toBe(0);
    expect(result.reason).toMatch(/not present in the latest accessibility snapshot/);
  });

  it("discovers a previously unknown completion control only from the fresh post-create snapshot", async () => {
    const completionScenario: PlannedScenario = {
      ...scenario,
      id: "SC-02",
      title: "Complete task",
      acceptanceCriteriaIds: ["AC-02"],
      steps: [{ intent: "Create a task, then discover and mark it complete.", expectedObservation: "The task is observed with checked completion state." }],
      verificationChecks: [{
        acceptanceCriterionId: "AC-02",
        kind: "checked",
        expectedVisible: ["{{uniqueTaskText}}"],
        expectedAbsent: [],
      }],
      unknownControlsToDiscover: ["After creation, inspect a fresh snapshot for the completion checkbox."],
    };
    const agent = new FakeAgent([
      { ...createTaskDecision, arguments: { target: "e1", text: "QA-TEST-SC-02" } },
      { kind: "action", toolName: "browser_click", arguments: { target: "e2" }, rationale: "Use the newly observed completion control." },
      { kind: "finish", assessments: [{ acceptanceCriteriaId: "AC-02", meets: true, observedEvidence: "QA-TEST-SC-02", explanation: "Checked state appears." }], rationale: "Verified checked state." },
    ]);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const browser = new FakeBrowser([
      pageSnapshot("textbox [ref=e1]"),
      pageSnapshot('- listitem:\n  checkbox "Complete" [ref=e2] [unchecked]\n  text: QA-TEST-SC-02'),
      pageSnapshot('- listitem:\n  checkbox "Complete" [ref=e2] [checked]\n  text: QA-TEST-SC-02'),
    ]);
    const result = await executeScenario({
      agent,
      browser,
      issue: { ...issue, acceptanceCriteria: [...issue.acceptanceCriteria, { id: "AC-02", description: "Mark task complete." }] },
      scenario: completionScenario,
      runId: "TEST",
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 10, maxModelRequests: 10, maxSeconds: 10, maxRecoveryRetries: 1 },
    });
    expect(agent.responses).toHaveLength(3);
    expect(agent.responses[2]).toMatchObject({ kind: "finish", assessments: [{ acceptanceCriteriaId: "AC-02" }] });
    expect(result.status, result.reason).toBe("PASS");
    expect(browser.calls).toContain("browser_click");
    expect(agent.prompts[1]).toContain('checkbox "Complete" [ref=e2]');
    expect(agent.prompts[1]).toContain("After creation, inspect a fresh snapshot");
  });

  it("host-verifies checked, unchecked, filtered inclusion/exclusion, and deletion absence", () => {
    const unique = "QA-TEST-SC-01";
    const completedScenario: PlannedScenario = {
      ...scenario,
      acceptanceCriteriaIds: ["AC-01"],
      verificationChecks: [{ acceptanceCriterionId: "AC-01", kind: "checked", expectedVisible: ["{{uniqueTaskText}}"], expectedAbsent: [] }],
    };
    const checked = verifyScenarioChecks(completedScenario, issue, unique, [
      { stage: "initial", text: pageSnapshot("Initial") },
      { stage: "post_action", text: pageSnapshot(`- listitem:\n checkbox "Complete" [checked]\n text: ${unique}`) },
    ]);
    const unchecked = verifyScenarioChecks(completedScenario, issue, unique, [
      { stage: "initial", text: pageSnapshot("Initial") },
      { stage: "post_action", text: pageSnapshot(`- listitem:\n checkbox "Complete" [unchecked]\n text: ${unique}`) },
    ]);
    expect(checked[0]?.status).toBe("PASS");
    expect(unchecked[0]?.status).toBe("FAIL");

    const filterIssue = {
      ...issue,
      acceptanceCriteria: [{ id: "AC-03", description: "Active filter excludes completed tasks." }],
    };
    const filterScenario: PlannedScenario = {
      ...scenario,
      acceptanceCriteriaIds: ["AC-03"],
      verificationChecks: [{
        acceptanceCriterionId: "AC-03",
        kind: "filter",
        expectedVisible: ["{{uniqueTaskText}}-ACTIVE"],
        expectedAbsent: ["{{uniqueTaskText}}-COMPLETED"],
      }],
    };
    const beforeFilter = pageSnapshot(`- listitem: ${unique}-ACTIVE\n  - checkbox "Complete" [unchecked]\n- listitem: ${unique}-COMPLETED\n  - checkbox "Complete" [checked]`);
    const filtered = pageSnapshot(`link "Active" [current]\n- listitem: ${unique}-ACTIVE`);
    const filterPass = verifyScenarioChecks(filterScenario, filterIssue, unique, [
      { stage: "initial", text: pageSnapshot("Empty task list") },
      { stage: "post_action", text: beforeFilter },
      { stage: "post_action", text: filtered },
    ]);
    const filterFail = verifyScenarioChecks(filterScenario, filterIssue, unique, [
      { stage: "initial", text: pageSnapshot("Empty task list") },
      { stage: "post_action", text: beforeFilter },
      { stage: "post_action", text: pageSnapshot(`link "Active" [current]\n- listitem: ${unique}-ACTIVE\n- listitem: ${unique}-COMPLETED`) },
    ]);
    expect(filterPass[0]?.status).toBe("PASS");
    expect(filterFail[0]?.status).toBe("FAIL");

    const deletionScenario: PlannedScenario = {
      ...scenario,
      acceptanceCriteriaIds: ["AC-01"],
      verificationChecks: [{
        acceptanceCriterionId: "AC-01",
        kind: "absent_after_seen",
        expectedVisible: ["{{uniqueTaskText}}"],
        expectedAbsent: ["{{uniqueTaskText}}"],
      }],
    };
    const beforeRemoval = pageSnapshot(`- listitem: ${unique}\n  - button "Remove" [ref=e9]`);
    const removalAction = { toolName: "browser_click", arguments: { target: "e9" } };
    expect(verifyScenarioChecks(deletionScenario, issue, unique, [
      { stage: "initial", text: pageSnapshot("Empty list") },
      { stage: "post_action", text: beforeRemoval },
      { stage: "post_action", text: pageSnapshot(`textbox "New todo" [placeholder=${unique}]\nTodo list empty`), action: removalAction },
    ])[0]?.status).toBe("PASS");
    expect(verifyScenarioChecks(deletionScenario, issue, unique, [
      { stage: "initial", text: pageSnapshot("Empty list") },
      { stage: "post_action", text: beforeRemoval },
      { stage: "post_action", text: pageSnapshot(`- listitem: ${unique}`), action: removalAction },
    ])[0]?.status).toBe("FAIL");
  });

  it("stops before exceeding the configured Gemini executor request budget", async () => {
    const agent = new FakeAgent([clickDecision, clickDecision]);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const browser = new FakeBrowser([pageSnapshot("Initial"), pageSnapshot("After click")]);
    const result = await executeScenario({
      agent,
      browser,
      issue,
      scenario,
      runId: "TEST",
      scenarioIndex: 1,
      screenshotDirectory,
      limits: { maxActions: 10, maxModelRequests: 1, maxSeconds: 10, maxRecoveryRetries: 1 },
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/Gemini executor request budget/);
    expect(agent.calls).toBe(1);
  });
});

describe("bounded invalid executor response recovery", () => {
  const invalidResponses: Array<{ label: string; response: unknown }> = [
    { label: "null", response: null },
    { label: "false", response: false },
    { label: "true", response: true },
    { label: "empty object", response: {} },
    { label: "array", response: [] },
    { label: "number", response: 5 },
    { label: "unknown kind", response: { kind: "unexpected", rationale: "Unrecognized discriminator" } },
    { label: "missing action arguments", response: { kind: "action", toolName: "browser_type", rationale: "Create task" } },
    { label: "missing toolName", response: { kind: "action", arguments: {}, rationale: "Create task" } },
    { label: "missing rationale", response: { kind: "action", toolName: "browser_type", arguments: { target: "e1", text: "Task" } } },
    { label: "missing finish assessments", response: { kind: "finish", rationale: "Finish" } },
    { label: "empty assessments", response: { kind: "finish", assessments: [], rationale: "Finish" } },
    { label: "missing assessment fields", response: { kind: "finish", assessments: [{ acceptanceCriterionId: "AC-01" }], rationale: "Finish" } },
  ];

  async function executeWith(agent: FakeAgent, browser = new FakeBrowser([pageSnapshot("Initial")]), overrides: Partial<{
    maxRecoveryRetries: number; maxModelRequests: number; maxSeconds: number;
  }> = {}) {
    screenshotDirectory = await mkdtemp(join(tmpdir(), "ui-qa-executor-"));
    const result = await executeScenario({
      agent, browser, issue, scenario, runId: "TEST", scenarioIndex: 1, screenshotDirectory,
      limits: { maxActions: 10, maxModelRequests: 10, maxSeconds: 10, maxRecoveryRetries: 1, ...overrides },
    });
    return { result, browser };
  }

  it.each(invalidResponses)("blocks repeated $label responses after exactly one recovery without unsafe actions", async ({ response }) => {
    vi.mocked(appendActionLog).mockClear();
    // A larger caller limit must never permit a second model-decision repair.
    const agent = new FakeAgent([response, response, createTaskDecision]);
    const { result, browser } = await executeWith(agent, undefined, { maxRecoveryRetries: 5 });
    expect(result).toMatchObject({ status: "BLOCKED", actionCount: 0, modelRequestCount: 2, recoveryCount: 1 });
    expect(result.reason).toMatch(/^Gemini executor response failed validation:/);
    expect(result.evidence).toHaveLength(1);
    expect(result.hostVerification).toEqual([]);
    expect(agent.calls).toBe(2);
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot"]);
    expect(agent.prompts[1]).toContain("The previous response failed validation");
    expect(agent.prompts[1]).toContain("only response-validation recovery");
    const invalidEvents = vi.mocked(appendActionLog).mock.calls.map(([event]) => event)
      .filter((event) => event.event === "executor_response_invalid");
    expect(invalidEvents).toHaveLength(2);
    expect(invalidEvents[0]).toMatchObject({ runId: "TEST", scenarioId: "SC-01", requestCount: 1 });
    expect(invalidEvents[1]).toMatchObject({ requestCount: 2, invalidDecisionRecoveryCount: 1 });
  });

  it.each([null, false, {}, new InvalidGeminiJsonError(), new InvalidGeminiJsonError("empty")])(
    "recovers an invalid response with a verified action and independent post-action evidence (%j)", async (response) => {
      const agent = new FakeAgent([response, createTaskDecision, passDecision("QA-TEST-SC-01")]);
      const browser = new FakeBrowser([pageSnapshot("Initial"), pageSnapshot("- listitem: QA-TEST-SC-01")]);
      const { result } = await executeWith(agent, browser);
      expect(result).toMatchObject({ status: "PASS", actionCount: 1, modelRequestCount: 3, recoveryCount: 1 });
      expect(result.hostVerification?.[0]).toMatchObject({ acceptanceCriterionId: "AC-01", status: "PASS" });
      expect(result.evidence).toHaveLength(3);
      expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot", "browser_type", "browser_snapshot"]);
    },
  );

  it("requires the recovery response to pass Zod and exact tool validation before any action", async () => {
    const unsafe = { kind: "action", toolName: "browser_click", arguments: { text: "not click arguments" }, rationale: "Use the wrong tool shape" };
    const agent = new FakeAgent([{}, unsafe, createTaskDecision]);
    const { result, browser } = await executeWith(agent);
    expect(result).toMatchObject({ status: "BLOCKED", actionCount: 0, modelRequestCount: 2, recoveryCount: 1 });
    expect(result.reason).toContain("Missing required arguments for browser_click: target");
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  it.each([
    { label: "unsafe tool", decision: { kind: "action", toolName: "browser_run_code_unsafe", arguments: {}, rationale: "Run code" } },
    { label: "off-origin navigation", decision: { kind: "action", toolName: "browser_navigate", arguments: { url: "https://other.test/" }, rationale: "Navigate away" } },
    { label: "stale reference", decision: { ...clickDecision, arguments: { target: "e999" } } },
  ])("rejects a corrected response containing $label", async ({ decision }) => {
    const agent = new FakeAgent([false, decision, createTaskDecision]);
    const { result, browser } = await executeWith(agent, undefined, { maxRecoveryRetries: 5 });
    expect(result).toMatchObject({ status: "BLOCKED", actionCount: 0, modelRequestCount: 2 });
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot"]);
    expect(agent.calls).toBe(2);
  });

  it("never treats a corrected finish with fabricated evidence as PASS", async () => {
    const agent = new FakeAgent([{}, passDecision("fabricated page evidence")]);
    const { result, browser } = await executeWith(agent);
    expect(result).toMatchObject({ status: "BLOCKED", actionCount: 0, modelRequestCount: 2, recoveryCount: 1 });
    expect(result.reason).toMatch(/No post-action accessibility snapshot/);
    expect(result.hostVerification?.[0]?.status).toBe("BLOCKED");
    expect(result.modelAssessments?.[0]?.evidenceStatus).toBe("UNSUPPORTED");
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  it("does not grant another repair after a corrected action executes", async () => {
    const agent = new FakeAgent([{}, createTaskDecision, false, createTaskDecision]);
    const browser = new FakeBrowser([pageSnapshot("Initial"), pageSnapshot("- listitem: QA-TEST-SC-01")]);
    const { result } = await executeWith(agent, browser, { maxRecoveryRetries: 5 });
    expect(result).toMatchObject({ status: "BLOCKED", actionCount: 1, modelRequestCount: 3, recoveryCount: 1 });
    expect(agent.calls).toBe(3);
  });

  it.each([
    { label: "disabled recovery", maxRecoveryRetries: 0, maxModelRequests: 10 },
    { label: "exhausted request budget", maxRecoveryRetries: 1, maxModelRequests: 1 },
  ])("respects $label when deciding whether to request a repair", async ({ maxRecoveryRetries, maxModelRequests }) => {
    const agent = new FakeAgent([{}, createTaskDecision]);
    const { result, browser } = await executeWith(agent, undefined, { maxRecoveryRetries, maxModelRequests });
    expect(result.status).toBe("BLOCKED");
    expect(result.actionCount).toBe(0);
    expect(result.modelRequestCount).toBe(1);
    expect(agent.calls).toBe(1);
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  it("keeps the recovery request within the remaining scenario deadline", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const agent = new FakeAgent([{}, createTaskDecision]);
    const generateJson = agent.generateJson.bind(agent);
    vi.spyOn(agent, "generateJson").mockImplementation(async (...args) => {
      const response = await generateJson(...args);
      now += 500;
      return response;
    });
    const { result, browser } = await executeWith(agent, undefined, { maxSeconds: 1 });
    expect(agent.timeouts).toEqual([1_000, 500]);
    expect(result).toMatchObject({ status: "BLOCKED", actionCount: 0, modelRequestCount: 2 });
    expect(result.reason).toBe("Scenario time limit reached while awaiting the Gemini decision.");
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  it("redacts model-controlled discriminator values, keys and body from rejection logs and feedback", async () => {
    vi.mocked(appendActionLog).mockClear();
    const secret = "private-page-content-and-api-key";
    const response = { kind: secret, [secret]: secret, rationale: secret };
    const agent = new FakeAgent([response, response]);
    const { result } = await executeWith(agent);
    const events = vi.mocked(appendActionLog).mock.calls.map(([event]) => event);
    const invalid = events.find((event) => event.event === "executor_response_invalid");
    expect(invalid).toMatchObject({
      responseType: "object", responseTopLevelKeys: ["kind", "rationale"],
      responseUnknownTopLevelKeyCount: 1, responseDiscriminator: "unknown_string",
      responseByteCount: Buffer.byteLength(JSON.stringify(response)),
    });
    expect(JSON.stringify({ events, reason: result.reason, feedback: agent.prompts[1] })).not.toContain(secret);
  });

  it("redacts stale-reference decision content and supplies reference-validation feedback to its one recovery", async () => {
    vi.mocked(appendActionLog).mockClear();
    const secret = "sensitive-invalid-decision-content";
    const agent = new FakeAgent([
      { ...createTaskDecision, arguments: { target: "e999", text: secret }, rationale: secret },
      {},
      createTaskDecision,
    ]);
    const browser = new FakeBrowser([pageSnapshot("Initial"), pageSnapshot("Fresh state")]);
    const { result } = await executeWith(agent, browser, { maxRecoveryRetries: 5 });
    expect(result).toMatchObject({ status: "BLOCKED", actionCount: 0, modelRequestCount: 2, recoveryCount: 1 });
    expect(agent.prompts[1]).toContain("Element reference e999 is not present in the latest accessibility snapshot");
    const events = vi.mocked(appendActionLog).mock.calls.map(([event]) => event);
    expect(events.find((event) => event.status === "stale_reference")).toMatchObject({
      event: "executor_response_invalid", responseDiscriminator: "action", responseType: "object",
    });
    expect(JSON.stringify({ events, reason: result.reason, feedback: agent.prompts[1] })).not.toContain(secret);
    expect(browser.calls).toEqual(["browser_navigate", "browser_snapshot", "browser_snapshot"]);
  });
});
