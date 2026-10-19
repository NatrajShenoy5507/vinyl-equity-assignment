import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedIssue, PlannedScenario, RunReport, ScenarioResult } from "../src/schemas.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  loadIssue: vi.fn(),
  explore: vi.fn(),
  plan: vi.fn(),
  execute: vi.fn(),
  revalidate: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  client: vi.fn(),
  writeReport: vi.fn(async (_report: RunReport) => undefined),
}));

vi.mock("../src/config.js", () => ({
  readConfig: mocks.config,
  parseCli: () => ({ source: "mock", help: false }),
  usage: "",
}));
vi.mock("../src/issues/mock-source.js", () => ({ loadMockIssue: mocks.loadIssue }));
vi.mock("../src/browser/explorer.js", () => ({ exploreApplication: mocks.explore }));
vi.mock("../src/agents/planner.js", () => ({
  generateScenarioPlan: mocks.plan,
  selectScenarios: (scenarios: PlannedScenario[]) => scenarios,
}));
vi.mock("../src/agents/executor.js", () => ({ executeScenario: mocks.execute }));
vi.mock("../src/agents/revalidator.js", () => ({ revalidateScenario: mocks.revalidate }));
vi.mock("../src/agents/gemini.js", () => ({
  GeminiAgent: class {
    constructor(...args: unknown[]) { mocks.client(...args); }
  },
}));
vi.mock("../src/browser/playwright-mcp.js", () => ({
  PlaywrightMcp: class {
    connect = mocks.connect;
    close = mocks.close;
  },
}));
vi.mock("../src/evidence/logger.js", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return {
    evidenceDirectory: await mkdtemp(join(tmpdir(), "ui-qa-orchestrator-")),
    appendActionLog: vi.fn(async () => undefined),
    resetActionLog: vi.fn(async () => undefined),
  };
});
vi.mock("../src/evidence/reporter.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/evidence/reporter.js")>(),
  writeReport: mocks.writeReport,
}));

import { main } from "../src/index.js";
import { evidenceDirectory } from "../src/evidence/logger.js";

const issue: NormalizedIssue = {
  issueNumber: 1, title: "Independent criteria", description: "Verify the feature", status: "RFQA",
  targetUrl: "https://demo.test/",
  acceptanceCriteria: [{ id: "AC-01", description: "Create" }, { id: "AC-02", description: "Complete" }],
};
const scenarios: PlannedScenario[] = issue.acceptanceCriteria.map(({ id, description }, index) => ({
  id: `SC-0${index + 1}`, title: description, acceptanceCriteriaIds: [id], preconditions: [],
  steps: [{ intent: description, expectedObservation: "Required state" }],
  verificationStrategy: "Check browser state", verificationChecks: [], relevantApplicationContext: [],
  unknownControlsToDiscover: [], expectedResult: "Required state",
}));

function resultFor(index: number, overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  const scenario = scenarios[index]!;
  return {
    scenarioId: scenario.id, title: scenario.title, acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
    status: "PASS", expected: "Required state", observed: "Observed state", reason: "Verified",
    evidence: [], actionCount: 1, recoveryCount: 0, ...overrides,
  };
}

function reported(): RunReport {
  expect(mocks.writeReport).toHaveBeenCalledOnce();
  return mocks.writeReport.mock.calls[0]![0];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  mocks.config.mockReturnValue({
    GEMINI_API_KEY: "unit-test-key", GEMINI_MODEL: "gemini-unit-test", GEMINI_EXECUTOR_TIMEOUT_MS: 45_000,
    HEADLESS: true, MAX_ACTIONS_PER_SCENARIO: 10, MAX_EXECUTOR_REQUESTS_PER_SCENARIO: 20,
    MAX_SCENARIO_SECONDS: 120, MAX_RECOVERY_RETRIES: 1,
  });
  mocks.loadIssue.mockResolvedValue(issue);
  mocks.explore.mockResolvedValue({ status: "PASS", evidence: {}, diagnostics: [], page: {} });
  mocks.plan.mockResolvedValue({ scenarios });
  mocks.connect.mockResolvedValue([]);
  mocks.close.mockResolvedValue(undefined);
  mocks.execute.mockImplementation(async ({ scenario }: { scenario: PlannedScenario }) =>
    resultFor(scenarios.findIndex(({ id }) => id === scenario.id)));
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => rm(evidenceDirectory, { recursive: true, force: true }));

describe("six-phase orchestration with mocked services", () => {
  it("marks Phase 4 BLOCKED after an HTTP 504 and records remaining scenarios as unattempted", async () => {
    mocks.execute.mockResolvedValueOnce(resultFor(0, {
      status: "BLOCKED", actionCount: 0, reason: "Gemini HTTP 504 DEADLINE_EXCEEDED", modelRequestCount: 1,
    }));

    expect(await main()).toBe(1);
    const report = reported();
    expect(report.status).toBe("BLOCKED");
    expect(report.totals).toEqual({ PASS: 0, FAIL: 0, BLOCKED: 2, SKIPPED: 0 });
    expect(report.phases?.find(({ phase }) => phase === 4)).toMatchObject({
      status: "BLOCKED", errors: expect.arrayContaining([expect.stringContaining("504")]),
    });
    expect(report.phases?.find(({ phase }) => phase === 5)?.status).toBe("NOT_RUN");
    expect(report.scenarios[1]).toMatchObject({
      scenarioId: "SC-02", status: "BLOCKED", actionCount: 0, evidence: [],
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.client).toHaveBeenCalledWith("unit-test-key", "gemini-unit-test", { runId: report.runId });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      limits: expect.objectContaining({ requestTimeoutMs: 45_000 }),
    }));
  });

  it("marks browser initialization blockers as Phase 4 BLOCKED", async () => {
    mocks.connect.mockRejectedValue(new Error("Browser initialization unavailable"));
    expect(await main()).toBe(1);
    expect(reported().phases?.find(({ phase }) => phase === 4)?.status).toBe("BLOCKED");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("forwards the configured request timeout into conditional failure revalidation", async () => {
    const failure = resultFor(0, { status: "FAIL", hostVerifiedFailure: true });
    mocks.execute.mockResolvedValueOnce(failure);
    mocks.revalidate.mockResolvedValueOnce(failure);
    expect(await main()).toBe(1);
    expect(mocks.revalidate).toHaveBeenCalledWith(expect.objectContaining({
      originalResult: failure,
      limits: expect.objectContaining({ requestTimeoutMs: 45_000 }),
    }));
  });

  it.each(["PASS", "FAIL"] as const)("keeps completed execution distinct from functional %s", async (status) => {
    mocks.execute.mockResolvedValueOnce(resultFor(0, { status }));
    expect(await main()).toBe(status === "PASS" ? 0 : 1);
    expect(reported().phases?.find(({ phase }) => phase === 4)?.status).toBe("COMPLETED");
    expect(reported().status).toBe(status);
  });
});
