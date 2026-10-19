import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScenarioPlan,
  generateScenarioPlan,
  selectScenarios,
  validateApplicationContext,
  validateScenarioPlan,
  type PlannerAgent,
} from "../src/agents/planner.js";
import { applicationContextSchema, type ApplicationContext } from "../src/browser/explorer.js";
import type { NormalizedIssue, ScenarioPlan } from "../src/schemas.js";
import * as plannerPrompts from "../src/prompts/planner-prompt.js";

const issue: NormalizedIssue = {
  issueNumber: 1,
  title: "Manage records",
  status: "RFQA",
  targetUrl: "https://example.test/",
  description: "As a user, I can search and manage records.",
  acceptanceCriteria: [
    { id: "AC-01", description: "A user can create a record." },
    { id: "AC-02", description: "A user can remove a record." },
  ],
};

function makeApplicationContext(overrides: Partial<ApplicationContext> = {}): ApplicationContext {
  return applicationContextSchema.parse({
    schemaVersion: 1,
    runId: "exploration-01",
    status: "PASS",
    startedAt: "2026-10-18T08:00:00.000Z",
    completedAt: "2026-10-18T08:00:03.000Z",
    targetUrl: issue.targetUrl,
    page: {
      title: "Observed application",
      currentUrl: issue.targetUrl,
      observedAt: "2026-10-18T08:00:02.000Z",
      accessibilitySnapshot: '- textbox "Search items" [ref=e8]\n- button "Add record" [ref=e9]',
      visibleSemanticControls: [
        { role: "textbox", name: "Search items", reference: "e8", observedAttributes: ["active"] },
        { role: "button", name: "Add record", reference: "e9", observedAttributes: [] },
      ],
    },
    evidence: {
      screenshot: "screenshots/exploration-01/exploration.png",
      accessibilitySnapshotSource: "page.accessibilitySnapshot",
    },
    sourceReferences: {
      targetUrl: issue.targetUrl,
      navigationTool: "browser_navigate",
      snapshotTool: "browser_snapshot",
      screenshotTool: "browser_take_screenshot",
    },
    unknowns: ["Some controls may appear only after a record has been created."],
    diagnostics: [],
    ...overrides,
  });
}

function makeScenario(context: ApplicationContext = makeApplicationContext()) {
  const observed = context.page.visibleSemanticControls[0]!;
  return {
    id: "SC-01",
    title: "Create a record",
    acceptanceCriteriaIds: ["AC-01"],
    preconditions: ["The application is open in its initial state."],
    steps: [
      { intent: "Create a record with unique test data.", expectedObservation: "The new record is visible." },
    ],
    verificationStrategy: "Verify creation from fresh accessibility snapshots and actual browser results.",
    verificationChecks: [
      { acceptanceCriterionId: "AC-01", kind: "visible", expectedVisible: ["{{uniqueTaskText}}"], expectedAbsent: [] },
    ],
    relevantApplicationContext: [`${observed.role}: ${observed.name} (${observed.observedAttributes.join(", ")})`],
    unknownControlsToDiscover: ["Inspect fresh accessibility data for any additional creation controls; do not assume one exists."],
    expectedResult: "The created record remains visible in the final observation.",
  };
}

function validPlan(context: ApplicationContext = makeApplicationContext()): ScenarioPlan {
  const removalScenario = {
    ...makeScenario(context),
    id: "SC-02",
    title: "Remove a record",
    acceptanceCriteriaIds: ["AC-02"],
    steps: [
      { intent: "Create a record with unique test data within this scenario.", expectedObservation: "The record is visible before removal." },
      { intent: "Inspect the new record and use its observed removal control if available.", expectedObservation: "The record is absent after removal." },
    ],
    verificationStrategy: "Verify prior presence and final absence from fresh accessibility snapshots and actual browser results.",
    verificationChecks: [
      { acceptanceCriterionId: "AC-02", kind: "absent_after_seen", expectedVisible: ["{{uniqueTaskText}}"], expectedAbsent: ["{{uniqueTaskText}}"] },
    ],
    unknownControlsToDiscover: ["After creating a record, discover its removal control from fresh accessibility data; do not assume one exists."],
    expectedResult: "The record created in this scenario is absent in the final observation.",
  };
  return { issueNumber: issue.issueNumber, scenarios: [makeScenario(context), removalScenario] };
}

const filterIssue: NormalizedIssue = {
  ...issue,
  acceptanceCriteria: [{ id: "AC-01", description: "The Active filter hides completed tasks and shows active tasks." }],
};

function validFilterPlan(context: ApplicationContext = makeApplicationContext()): ScenarioPlan {
  return {
    issueNumber: issue.issueNumber,
    scenarios: [{
      ...makeScenario(context),
      title: "Filter current-scenario tasks",
      steps: [
        { intent: "Create a unique active task and inspect its state.", expectedObservation: "The included task is visible and unchecked." },
        { intent: "Create a separate unique task and mark it complete using discovered controls.", expectedObservation: "The excluded task is visible and checked." },
        { intent: "Select the Active filter using the currently observed control.", expectedObservation: "The included task remains visible and the excluded task is hidden." },
      ],
      verificationChecks: [{
        acceptanceCriterionId: "AC-01",
        kind: "filter",
        expectedVisible: ["{{uniqueTaskText}}-ACTIVE"],
        expectedAbsent: ["{{uniqueTaskText}}-COMPLETED"],
      }],
      expectedResult: "The Active filter includes the active task and hides the completed task.",
    }],
  };
}

class FakePlanner implements PlannerAgent {
  readonly model = "gemini-test-model";
  readonly prompts: string[] = [];
  readonly schemas: Array<Record<string, unknown>> = [];
  calls = 0;

  constructor(private readonly respond: (prompt: string, call: number) => unknown | Error) {}

  async generateJson(prompt: string, schema: Record<string, unknown>): Promise<unknown> {
    this.calls += 1;
    this.prompts.push(prompt);
    this.schemas.push(schema);
    const response = this.respond(prompt, this.calls);
    if (response instanceof Error) throw response;
    return response;
  }
}

const temporaryDirectories: string[] = [];

async function makePaths(): Promise<{ cachePath: string; artifactPath: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), "scenario-planner-"));
  temporaryDirectories.push(directory);
  return {
    cachePath: resolve(directory, "scenario-plan-cache.json"),
    artifactPath: resolve(directory, "generated-scenarios.json"),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("context-aware scenario plan validation", () => {
  it("generates a validated plan from both issue requirements and observed application context", async () => {
    const context = makeApplicationContext();
    const agent = new FakePlanner(() => validPlan(context));
    const plan = await createScenarioPlan(agent, issue, context);

    expect(plan.scenarios).toHaveLength(2);
    expect(plan.scenarios.map((scenario) => scenario.acceptanceCriteriaIds)).toEqual([["AC-01"], ["AC-02"]]);
    expect(plan.scenarios[0]?.verificationStrategy).toContain("fresh accessibility snapshots");
    expect(plan.scenarios[0]?.unknownControlsToDiscover[0]).toContain("do not assume");
    expect(agent.prompts[0]).toContain(issue.description);
    expect(agent.prompts[0]).toContain("A user can remove a record.");
    expect(agent.prompts[0]).toContain("Observed application");
    expect(agent.prompts[0]).toContain("Search items");
    expect(agent.prompts[0]).not.toContain("[ref=e8]");
    expect(agent.prompts[0]).not.toContain("accessibilitySnapshot");
    expect(agent.prompts[0]).toContain("Each scenario must verify exactly one acceptance criterion");
    expect(agent.prompts[0]).toContain("Establish all prerequisite data and state within that scenario's steps");
    expect(agent.prompts[0]).toContain("do not add cleanup or later lifecycle actions that invalidate its evidence");
    expect(agent.schemas[0]?.additionalProperties).toBe(false);
    expect(agent.schemas[0]?.required).toContain("scenarios");
  });

  it("requires complete coverage, rejects unknown criteria and duplicate IDs", () => {
    const context = makeApplicationContext();
    expect(validateScenarioPlan(validPlan(context), issue, context).scenarios).toHaveLength(2);
    expect(() => validateScenarioPlan({ ...validPlan(context), scenarios: [{ ...makeScenario(context), acceptanceCriteriaIds: ["AC-01"] }] }, issue, context)).toThrow(/does not cover: AC-02/);
    expect(() => validateScenarioPlan({ ...validPlan(context), scenarios: [{ ...makeScenario(context), acceptanceCriteriaIds: ["AC-99"] }] }, issue, context)).toThrow(/unknown acceptance criterion AC-99/);
    expect(() => validateScenarioPlan({ ...validPlan(context), scenarios: [makeScenario(context), { ...makeScenario(context) }] }, issue, context)).toThrow(/duplicate scenario IDs/);
  });

  it("rejects combined lifecycle criteria and repairs them into independently verifiable final states", async () => {
    const context = makeApplicationContext();
    const independent = validPlan(context);
    const combined = {
      issueNumber: issue.issueNumber,
      scenarios: [{
        ...makeScenario(context),
        acceptanceCriteriaIds: ["AC-01", "AC-02"],
        verificationChecks: independent.scenarios.flatMap((scenario) => scenario.verificationChecks),
      }],
    };
    expect(() => validateScenarioPlan(combined, issue, context)).toThrow(/exactly one acceptance criterion independently/);
    const agent = new FakePlanner((_prompt, call) => call === 1 ? combined : independent);
    await expect(createScenarioPlan(agent, issue, context)).resolves.toEqual(independent);
    expect(agent.calls).toBe(2);
    expect(agent.prompts[1]).toContain("exactly one acceptance criterion independently");
    expect(independent.scenarios[0]?.verificationChecks[0]?.kind).toBe("visible");
    expect(independent.scenarios[1]?.steps[0]?.intent).toContain("within this scenario");
    expect(independent.scenarios[1]?.verificationChecks[0]?.kind).toBe("absent_after_seen");
  });

  it("plans filter prerequisites using current-scenario identities and independently observed completion states", async () => {
    const context = makeApplicationContext();
    const agent = new FakePlanner(() => validFilterPlan(context));
    await expect(createScenarioPlan(agent, filterIssue, context)).resolves.toEqual(validFilterPlan(context));
    expect(agent.prompts[0]).toContain("independently observe each included subject as unchecked and each excluded subject as checked");
    expect(agent.prompts[0]).toContain("before selecting the final filter");
    expect(agent.prompts[0]).toContain("A task merely named \"COMPLETED\" does not prove completion");
    expect(agent.prompts[0]).toContain("inspect and restore a suitable visible state");
    expect(agent.prompts[0]).toContain("literal names observed during exploration or previous runs");
  });

  it.each([
    ["missing included subject", [], ["{{uniqueTaskText}}-COMPLETED"], /both included and excluded text/],
    ["missing excluded subject", ["{{uniqueTaskText}}-ACTIVE"], [], /both included and excluded text/],
    ["stale included identity", ["QA-old-run-ACTIVE"], ["{{uniqueTaskText}}-COMPLETED"], /current-scenario task markers/],
    ["stale excluded identity", ["{{uniqueTaskText}}-ACTIVE"], ["QA-old-run-COMPLETED"], /current-scenario task markers/],
    ["shared task identity", ["{{uniqueTaskText}}-TASK"], ["{{uniqueTaskText}}-TASK"], /distinct, non-overlapping/],
    ["overlapping task identities", ["{{uniqueTaskText}}"], ["{{uniqueTaskText}}-COMPLETED"], /distinct, non-overlapping/],
    ["duplicate included identity", ["{{uniqueTaskText}}-ACTIVE", "{{uniqueTaskText}}-ACTIVE"], ["{{uniqueTaskText}}-COMPLETED"], /distinct, non-overlapping/],
  ] as const)("rejects filter plans with %s", (_label, expectedVisible, expectedAbsent, error) => {
    const context = makeApplicationContext();
    const plan = validFilterPlan(context);
    plan.scenarios[0]!.verificationChecks[0]!.expectedVisible = [...expectedVisible];
    plan.scenarios[0]!.verificationChecks[0]!.expectedAbsent = [...expectedAbsent];
    expect(() => validateScenarioPlan(plan, filterIssue, context)).toThrow(error);
  });

  it("repairs stale filter identities before a plan can be executed", async () => {
    const context = makeApplicationContext();
    const stale = validFilterPlan(context);
    stale.scenarios[0]!.verificationChecks[0]!.expectedAbsent = ["QA-previous-run-COMPLETED"];
    const agent = new FakePlanner((_prompt, call) => call === 1 ? stale : validFilterPlan(context));
    await expect(createScenarioPlan(agent, filterIssue, context)).resolves.toEqual(validFilterPlan(context));
    expect(agent.calls).toBe(2);
    expect(agent.prompts[1]).toContain("current-scenario task markers");
  });

  it("rejects missing, malformed, blocked, or mismatched application context", () => {
    expect(() => validateApplicationContext({}, issue)).toThrow(/Application context is malformed/);
    expect(() => validateApplicationContext(makeApplicationContext({ status: "BLOCKED" }), issue)).toThrow(/not successful/);
    expect(() => validateApplicationContext({
      ...makeApplicationContext(),
      page: { ...makeApplicationContext().page, accessibilitySnapshot: null },
    }, issue)).toThrow(/malformed|missing the accessibility snapshot/i);
    const otherTarget = makeApplicationContext({ targetUrl: "https://elsewhere.test/" });
    expect(() => validateApplicationContext(otherTarget, issue)).toThrow(/does not match/);
  });

  it("permits unknown controls to be planned for discovery but rejects invented observed affordances", () => {
    const context = makeApplicationContext();
    const plan = validPlan(context);
    expect(plan.scenarios[0]?.unknownControlsToDiscover).toHaveLength(1);
    const scenarioWithInventedControl = {
      ...makeScenario(context),
      relevantApplicationContext: ["checkbox: Complete record"],
    };
    expect(() => validateScenarioPlan({ issueNumber: 1, scenarios: [scenarioWithInventedControl, validPlan(context).scenarios[1]] }, issue, context)).toThrow(/unobserved application affordance/);
  });

  it.each([
    ["stale reference", (scenario: ReturnType<typeof makeScenario>) => ({ ...scenario, expectedResult: "Click target=e8." })],
    ["CSS selector", (scenario: ReturnType<typeof makeScenario>) => ({ ...scenario, expectedResult: "Use #record-delete to remove it." })],
    ["XPath selector", (scenario: ReturnType<typeof makeScenario>) => ({ ...scenario, expectedResult: "Use xpath=//button." })],
  ])("rejects %s text from executable plans", (_label, modifyScenario) => {
    const context = makeApplicationContext();
    expect(() => validateScenarioPlan({
      issueNumber: 1,
      scenarios: [modifyScenario(makeScenario(context)), validPlan(context).scenarios[1]],
    }, issue, context)).toThrow(/selector, script, or stale/);
  });

  it("repairs invalid Gemini JSON once and fails without fabricating a plan if still invalid", async () => {
    const context = makeApplicationContext();
    const repaired = new FakePlanner((_prompt, call) => call === 1
      ? new Error("Gemini returned invalid JSON: unexpected token")
      : validPlan(context));
    await expect(createScenarioPlan(repaired, issue, context)).resolves.toEqual(validPlan(context));
    expect(repaired.calls).toBe(2);

    const invalid = new FakePlanner(() => new Error("Gemini returned invalid JSON: unexpected token"));
    await expect(createScenarioPlan(invalid, issue, context)).rejects.toThrow(/planning failed after one format-repair attempt/);
    expect(invalid.calls).toBe(2);

    const quotaFailure = new FakePlanner(() => Object.assign(new Error("Gemini 429 quota exhausted"), { status: 429 }));
    await expect(createScenarioPlan(quotaFailure, issue, context)).rejects.toThrow(/quota exhausted/);
    expect(quotaFailure.calls).toBe(1);
  });

  it("records model-generated scenarios, acceptance mapping, and application context provenance", async () => {
    const paths = await makePaths();
    const context = makeApplicationContext();
    const agent = new FakePlanner(() => validPlan(context));
    const artifact = await generateScenarioPlan(agent, issue, context, "run-01", {
      ...paths,
      logAction: async () => undefined,
    });
    const persisted = JSON.parse(await readFile(paths.artifactPath, "utf8"));

    expect(artifact).toEqual(persisted);
    expect(artifact).toMatchObject({
      runId: "run-01",
      issueNumber: 1,
      modelName: agent.model,
      applicationContextReference: { path: "evidence/application-context.json", runId: context.runId },
      source: "gemini",
      cache: { status: "MISS", invalidationReason: "No validated plan cache exists." },
      acceptanceCriteriaMapping: { "AC-01": ["SC-01"], "AC-02": ["SC-02"] },
    });
    expect(artifact.generatedAt).toBeTruthy();
    expect(artifact.planningContractFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.scenarios).toEqual(validPlan(context).scenarios);
  });

  it.each(["missing", "outdated"])("invalidates a %s planning contract even when a cached plan still validates", async (contractState) => {
    const paths = await makePaths();
    const context = makeApplicationContext();
    const agent = new FakePlanner(() => validPlan(context));
    const options = { ...paths, logAction: async () => undefined };
    await generateScenarioPlan(agent, issue, context, "run-01", options);
    const cached = JSON.parse(await readFile(paths.cachePath, "utf8"));
    if (contractState === "missing") delete cached.planningContractFingerprint;
    else cached.planningContractFingerprint = "0".repeat(64);
    await writeFile(paths.cachePath, JSON.stringify(cached), "utf8");

    const regenerated = await generateScenarioPlan(agent, issue, context, "run-02", options);
    expect(regenerated.cache).toEqual({ status: "MISS", invalidationReason: "Planning contract, prompt, or response schema changed." });
    expect(agent.calls).toBe(2);
  });

  it.each(["prompt", "response schema"])("automatically invalidates a matching cache when the %s changes", async (changedContract) => {
    const paths = await makePaths();
    const context = makeApplicationContext();
    const agent = new FakePlanner(() => validPlan(context));
    const options = { ...paths, logAction: async () => undefined };
    const first = await generateScenarioPlan(agent, issue, context, "run-01", options);
    const responseSchema = agent.schemas[0]!;
    const originalPrompt = plannerPrompts.plannerPrompt;
    if (changedContract === "prompt") {
      vi.spyOn(plannerPrompts, "plannerPrompt").mockImplementation((...args) => `${originalPrompt(...args)}\nUpdated planning instruction.`);
    } else {
      responseSchema.description = "Updated planning response contract.";
    }
    try {
      const regenerated = await generateScenarioPlan(agent, issue, context, "run-02", options);
      expect(regenerated.cache).toEqual({ status: "MISS", invalidationReason: "Planning contract, prompt, or response schema changed." });
      expect(regenerated.planningContractFingerprint).not.toBe(first.planningContractFingerprint);
      expect(agent.calls).toBe(2);
    } finally {
      delete responseSchema.description;
    }
  });

  it("does not create a plan artifact or cache when Gemini never returns a valid plan", async () => {
    const paths = await makePaths();
    const context = makeApplicationContext();
    const agent = new FakePlanner(() => new Error("Gemini returned invalid JSON: unexpected token"));
    await expect(generateScenarioPlan(agent, issue, context, "failed-run", {
      ...paths,
      logAction: async () => undefined,
    })).rejects.toThrow(/planning failed after one format-repair attempt/);
    await expect(readFile(paths.artifactPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.cachePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses only a validated matching plan and regenerates when the observed application context changes", async () => {
    const paths = await makePaths();
    const context = makeApplicationContext();
    const agent = new FakePlanner(() => validPlan(context));
    const first = await generateScenarioPlan(agent, issue, context, "run-01", {
      ...paths,
      logAction: async () => undefined,
    });
    const reused = await generateScenarioPlan(agent, issue, context, "run-02", {
      ...paths,
      logAction: async () => undefined,
    });
    expect(first.cache.status).toBe("MISS");
    expect(reused.cache.status).toBe("HIT");
    expect(reused.source).toBe("validated-cache");
    expect(reused.runId).toBe("run-02");
    expect(agent.calls).toBe(1);

    const changedContext = makeApplicationContext({
      page: { ...context.page, title: "Observed application version 2" },
    });
    const regenerated = await generateScenarioPlan(agent, issue, changedContext, "run-03", {
      ...paths,
      logAction: async () => undefined,
    });
    expect(regenerated.cache).toEqual({
      status: "MISS",
      invalidationReason: "Observed application context changed.",
    });
    expect(regenerated.source).toBe("gemini");
    expect(agent.calls).toBe(2);
  });

  it("selects only the requested generated scenario and rejects unknown IDs", () => {
    const scenarios = validPlan().scenarios;
    expect(selectScenarios(scenarios, "SC-01")).toEqual([scenarios[0]]);
    expect(selectScenarios(scenarios)).toEqual(scenarios);
    expect(() => selectScenarios(scenarios, "SC-99")).toThrow(/not found in the generated plan/);
  });
});
