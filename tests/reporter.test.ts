import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAcceptanceCriteriaTrace,
  buildArtifactInventory,
  buildEnvironment,
  buildReport,
  renderMarkdown,
  summarizeStatus,
} from "../src/evidence/reporter.js";
import { PhaseLedger } from "../src/evidence/phase-ledger.js";
import type { ScenarioResult } from "../src/schemas.js";
import { evidenceDirectory } from "../src/evidence/logger.js";

function baseScenario(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: "SC-01",
    title: "Create item",
    acceptanceCriteriaIds: ["AC-01"],
    status: "PASS",
    expected: "Item visible",
    observed: "Item visible in snapshot",
    reason: "Host verification passed.",
    evidence: [],
    actionCount: 2,
    recoveryCount: 0,
    preconditions: ["Empty list"],
    intendedSteps: [{ intent: "Add item", expectedObservation: "Item appears" }],
    verificationStrategy: "Confirm list item text in accessibility snapshot.",
    browserActions: [{
      toolName: "browser_click",
      arguments: { target: "e1" },
      rationale: "Click add",
      status: "ok",
      result: "clicked",
    }],
    hostVerification: [{
      acceptanceCriterionId: "AC-01",
      status: "PASS",
      reason: "Visible in snapshot",
      evidence: ["quote"],
    }],
    executionDurationMs: 1200,
    modelRequestCount: 3,
    ...overrides,
  };
}

const criteria = [
  { id: "AC-01", description: "User can create a todo" },
  { id: "AC-02", description: "User can complete a todo" },
];

describe("report generation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reports independent outcome totals and links only supplied evidence", () => {
    const report = buildReport({
      runId: "run1", source: "mock", model: "gemini-test", issueNumber: 1, issueTitle: "Todos",
      targetUrl: "https://example.test/", startedAt: "start", completedAt: "end",
      scenarios: [{
        scenarioId: "SC-01", title: "Create", acceptanceCriteriaIds: ["AC-01"], status: "BLOCKED",
        expected: "Item visible", observed: "No execution", reason: "Missing API key",
        evidence: [], actionCount: 0, recoveryCount: 0,
      }],
    });
    expect(report.totals).toEqual({ PASS: 0, FAIL: 0, BLOCKED: 1, SKIPPED: 0 });
    expect(renderMarkdown(report)).toContain("Missing API key");
    expect(renderMarkdown(report)).not.toContain("screenshots/");
  });

  it("marks overall PASS when all scenarios PASS and AC PASS only with host verification", () => {
    const scenarios = [
      baseScenario(),
      baseScenario({
        scenarioId: "SC-02",
        title: "Complete item",
        acceptanceCriteriaIds: ["AC-02"],
        hostVerification: [{
          acceptanceCriterionId: "AC-02",
          status: "PASS",
          reason: "Checked state observed",
          evidence: ["checked"],
        }],
      }),
    ];
    const report = buildReport({
      runId: "pass-run",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      scenarios,
      acceptanceCriteria: buildAcceptanceCriteriaTrace(criteria, scenarios),
      phases: new PhaseLedger().summaries(),
    });
    expect(report.status).toBe("PASS");
    expect(report.acceptanceCriteria?.every((criterion) => criterion.status === "PASS")).toBe(true);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("## Acceptance criteria traceability");
    expect(markdown).toContain("## Six-phase execution summary");
  });

  it("keeps overall FAIL and AC FAIL for host-verified functional failures", () => {
    const scenarios = [
      baseScenario({
        status: "FAIL",
        hostVerifiedFailure: true,
        reason: "AC-01 contradicted by host-verified browser state",
        hostVerification: [{
          acceptanceCriterionId: "AC-01",
          status: "FAIL",
          reason: "Item missing",
          evidence: ["absent"],
        }],
      }),
      baseScenario({
        scenarioId: "SC-02",
        acceptanceCriteriaIds: ["AC-02"],
        hostVerification: [{
          acceptanceCriterionId: "AC-02",
          status: "PASS",
          reason: "ok",
          evidence: [],
        }],
      }),
    ];
    const report = buildReport({
      runId: "fail-run",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      scenarios,
      acceptanceCriteria: buildAcceptanceCriteriaTrace(criteria, scenarios),
    });
    expect(report.status).toBe("FAIL");
    expect(report.totals.FAIL).toBe(1);
    expect(report.acceptanceCriteria?.find((criterion) => criterion.id === "AC-01")?.status).toBe("FAIL");
  });

  it("treats Gemini API service errors as infrastructure BLOCKED without fabricating PASS", () => {
    const scenarios = [baseScenario({
      status: "BLOCKED",
      reason: "Gemini API returned 429 Too Many Requests",
      hostVerification: undefined,
      browserActions: undefined,
      executionDurationMs: undefined,
      modelRequestCount: 1,
    })];
    const report = buildReport({
      runId: "blocked-run",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      blocker: "Gemini service request failed; remaining scenarios were not attempted. Gemini API returned 429 Too Many Requests",
      scenarios,
      acceptanceCriteria: buildAcceptanceCriteriaTrace(criteria, scenarios),
    });
    expect(report.status).toBe("BLOCKED");
    expect(report.acceptanceCriteria?.find((criterion) => criterion.id === "AC-01")?.status).toBe("UNVERIFIED");
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("429");
    expect(markdown).toContain("infrastructure BLOCKED");
    expect(markdown).not.toMatch(/\*\*PASS\*\*.*AC-01/);
  });

  it("reports Phase 2 exploration failure with later phases NOT_RUN", () => {
    const ledger = new PhaseLedger();
    ledger.start(1);
    ledger.complete(1, "COMPLETED");
    ledger.start(2);
    ledger.complete(2, "BLOCKED", { errors: ["navigate: target unreachable"] });
    ledger.markRemainingNotRun(3, "Application exploration was blocked.");
    ledger.start(6);
    ledger.complete(6, "COMPLETED", { outputArtifacts: ["evidence/report.md"] });
    const report = buildReport({
      runId: "explore-fail",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      blocker: "Application exploration was blocked. navigate: target unreachable",
      phases: ledger.summaries(),
      scenarios: [{
        scenarioId: "APPLICATION-EXPLORATION",
        title: "Phase 2 application exploration",
        acceptanceCriteriaIds: [],
        status: "BLOCKED",
        expected: "Capture page",
        observed: "No snapshot",
        reason: "navigate: target unreachable",
        evidence: [],
        actionCount: 0,
        recoveryCount: 0,
      }],
      environment: buildEnvironment(true),
    });
    expect(report.phases?.find((phase) => phase.phase === 2)?.status).toBe("BLOCKED");
    expect(report.phases?.find((phase) => phase.phase === 3)?.status).toBe("NOT_RUN");
    expect(report.phases?.find((phase) => phase.phase === 5)?.status).toBe("NOT_RUN");
    expect(renderMarkdown(report)).toContain("Six-phase execution summary");
    expect(renderMarkdown(report)).toContain("target unreachable");
  });

  it("reports Phase 3 planning failure with execution phases NOT_RUN", () => {
    const ledger = new PhaseLedger();
    ledger.start(1);
    ledger.complete(1, "COMPLETED");
    ledger.start(2);
    ledger.complete(2, "COMPLETED");
    ledger.start(3);
    ledger.complete(3, "FAILED", { errors: ["Scenario plan omitted AC-02"] });
    ledger.markRemainingNotRun(4, "Scenario generation did not complete.");
    ledger.start(6);
    ledger.complete(6, "COMPLETED");
    const scenarios = criteria.map((criterion, index) => ({
      scenarioId: `UNPLANNED-0${index + 1}`,
      title: `Unverified: ${criterion.id}`,
      acceptanceCriteriaIds: [criterion.id],
      status: "BLOCKED" as const,
      expected: criterion.description,
      observed: "No browser execution occurred.",
      reason: "Scenario plan omitted AC-02",
      evidence: [],
      actionCount: 0,
      recoveryCount: 0,
    }));
    const report = buildReport({
      runId: "plan-fail",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      blocker: "Scenario plan omitted AC-02",
      phases: ledger.summaries(),
      scenarios,
      acceptanceCriteria: buildAcceptanceCriteriaTrace(criteria, scenarios),
    });
    expect(report.phases?.find((phase) => phase.phase === 3)?.status).toBe("FAILED");
    expect(report.phases?.find((phase) => phase.phase === 4)?.status).toBe("NOT_RUN");
    expect(report.acceptanceCriteria?.every((criterion) => criterion.status === "UNVERIFIED")).toBe(true);
  });

  it("reports partial Phase 4 execution without inventing missing durations", () => {
    const scenarios = [
      baseScenario({ executionDurationMs: 900 }),
      baseScenario({
        scenarioId: "SC-02",
        title: "Filter",
        acceptanceCriteriaIds: ["AC-02"],
        status: "BLOCKED",
        reason: "Gemini service request failed; no further scenarios were attempted.",
        observed: "Execution stopped before browser verification.",
        browserActions: undefined,
        hostVerification: undefined,
        executionDurationMs: undefined,
        modelRequestCount: undefined,
        actionCount: 0,
      }),
    ];
    const markdown = renderMarkdown(buildReport({
      runId: "partial",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      scenarios,
    }));
    expect(markdown).toContain("900 ms");
    expect(markdown).toContain("Execution duration:** unavailable");
    expect(markdown).toContain("Gemini requests / browser actions / recoveries:** unavailable / 0 / 0");
  });

  it("reports Phase 5 as not required when no host-verified failure occurred", () => {
    const ledger = new PhaseLedger();
    ledger.start(5);
    ledger.markNotRun(5, "No host-verified functional failure; revalidation was not required.");
    const markdown = renderMarkdown(buildReport({
      runId: "no-reval",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      phases: ledger.summaries(),
      scenarios: [baseScenario()],
    }));
    expect(markdown).toContain("Revalidation was not required or not executed");
    expect(markdown).toContain("NOT_RUN");
    expect(markdown).not.toContain("CONFIRMED_FAILURE");
  });

  it("keeps original FAIL in totals for confirmed failure revalidation", () => {
    const original = baseScenario({
      status: "FAIL",
      hostVerifiedFailure: true,
      reason: "AC-01 failed",
      hostVerification: [{
        acceptanceCriterionId: "AC-01",
        status: "FAIL",
        reason: "missing",
        evidence: [],
      }],
    });
    const { revalidation: _ignored, ...originalWithoutRevalidation } = original;
    const scenarios = [baseScenario({
      ...original,
      revalidation: {
        originalRunId: "run-a",
        revalidationRunId: "run-a-reval",
        attemptCount: 1,
        originalFailureReason: "AC-01 failed",
        originalResult: originalWithoutRevalidation,
        attemptResult: {
          ...originalWithoutRevalidation,
          status: "FAIL",
          reason: "Retry also failed",
          evidence: [],
        },
        classification: "CONFIRMED_FAILURE",
      },
    })];
    const report = buildReport({
      runId: "confirmed",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      scenarios,
    });
    expect(report.status).toBe("FAIL");
    expect(report.totals.FAIL).toBe(1);
    expect(report.totals.PASS).toBe(0);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("## Revalidation details");
    expect(markdown).toContain("CONFIRMED_FAILURE");
    expect(markdown).toContain("run-a-reval");
    expect(markdown).toContain("Original scenario status retained in totals");
  });

  it("reports flaky revalidation without converting original FAIL to PASS", () => {
    const original = baseScenario({
      status: "FAIL",
      hostVerifiedFailure: true,
      reason: "AC-01 failed",
    });
    const { revalidation: _ignored, ...originalWithoutRevalidation } = original;
    const scenarios = [baseScenario({
      ...original,
      revalidation: {
        originalRunId: "run-b",
        revalidationRunId: "run-b-reval",
        attemptCount: 1,
        originalFailureReason: "AC-01 failed",
        originalResult: originalWithoutRevalidation,
        attemptResult: {
          ...originalWithoutRevalidation,
          status: "PASS",
          reason: "Retry passed unexpectedly",
          evidence: [],
        },
        classification: "FLAKY_OR_INCONSISTENT",
      },
    })];
    const report = buildReport({
      runId: "flaky",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      scenarios,
    });
    expect(summarizeStatus(scenarios)).toBe("FAIL");
    expect(report.totals.FAIL).toBe(1);
    expect(renderMarkdown(report)).toContain("FLAKY_OR_INCONSISTENT");
  });

  it("labels missing screenshots and evidence as unavailable", async () => {
    const missing = resolve(evidenceDirectory, "screenshots", "missing-run", "SC-01-01.png");
    const scenarios = [baseScenario({ evidence: [] })];
    const artifacts = await buildArtifactInventory([
      { label: "Missing screenshot", path: missing },
      { label: "Action log", path: resolve(evidenceDirectory, "action-log.ndjson") },
    ]);
    const report = buildReport({
      runId: "missing-evidence",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      scenarios,
      artifacts,
      acceptanceCriteria: buildAcceptanceCriteriaTrace(criteria, scenarios),
    });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("**Screenshots:** unavailable");
    expect(markdown).toContain("| Missing screenshot |");
    expect(markdown).toContain("| no |");
    expect(report.acceptanceCriteria?.[0]?.status).toBe("PASS");
    expect(report.acceptanceCriteria?.[1]?.status).toBe("UNVERIFIED");
  });

  it("does not mark an AC PASS solely because a scenario references it", () => {
    const scenarios = [baseScenario({
      acceptanceCriteriaIds: ["AC-01", "AC-02"],
      hostVerification: [{
        acceptanceCriterionId: "AC-01",
        status: "PASS",
        reason: "verified",
        evidence: ["ok"],
      }],
    })];
    const trace = buildAcceptanceCriteriaTrace(criteria, scenarios);
    expect(trace.find((criterion) => criterion.id === "AC-01")?.status).toBe("PASS");
    expect(trace.find((criterion) => criterion.id === "AC-02")?.status).toBe("UNVERIFIED");
  });

  it("renders dual-write-ready report content without fabricating secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vinyl-report-"));
    tempDirs.push(dir);
    const runId = "dual-write-run";
    const report = buildReport({
      runId,
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      scenarios: [baseScenario()],
      environment: buildEnvironment(false),
    });
    await mkdir(join(dir, "runs", runId), { recursive: true });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderMarkdown(report);
    await writeFile(join(dir, "report.json"), json, "utf8");
    await writeFile(join(dir, "report.md"), markdown, "utf8");
    await writeFile(join(dir, "runs", runId, "report.json"), json, "utf8");
    await writeFile(join(dir, "runs", runId, "report.md"), markdown, "utf8");
    const written = await readFile(join(dir, "runs", runId, "report.md"), "utf8");
    expect(written).toContain("Executive summary");
    expect(written).toContain("Final status");
    expect(written).not.toContain("API_KEY");
    expect(written).not.toContain("sk-");
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).runId).toBe(runId);
  });

  it("includes comprehensive scenario fields in Markdown when present", () => {
    const markdown = renderMarkdown(buildReport({
      runId: "detail",
      source: "mock",
      model: "gemini-test",
      issueNumber: 1,
      issueTitle: "Todos",
      targetUrl: "https://example.test/",
      startedAt: "start",
      completedAt: "end",
      scenarios: [baseScenario()],
    }));
    expect(markdown).toContain("Preconditions");
    expect(markdown).toContain("Intended steps");
    expect(markdown).toContain("Verification strategy");
    expect(markdown).toContain("Actual browser actions");
    expect(markdown).toContain("Host-verified assertion outcomes");
    expect(markdown).toContain("browser_click");
  });
});

describe("phase ledger", () => {
  it("tracks COMPLETED, BLOCKED, FAILED, and NOT_RUN distinctly from scenario statuses", () => {
    const ledger = new PhaseLedger();
    ledger.start(1, "2026-01-01T00:00:00.000Z");
    ledger.complete(1, "COMPLETED", { completedAt: "2026-01-01T00:00:01.000Z" });
    ledger.start(2, "2026-01-01T00:00:01.000Z");
    ledger.complete(2, "BLOCKED", { completedAt: "2026-01-01T00:00:02.000Z", errors: ["unreachable"] });
    ledger.markRemainingNotRun(3, "Exploration blocked");
    const summaries = ledger.summaries();
    expect(summaries[0]?.status).toBe("COMPLETED");
    expect(summaries[0]?.durationMs).toBe(1000);
    expect(summaries[1]?.status).toBe("BLOCKED");
    expect(summaries[2]?.status).toBe("NOT_RUN");
    expect(summaries[4]?.status).toBe("NOT_RUN");
    expect(summaries[5]?.status).toBe("NOT_RUN");
  });
});
