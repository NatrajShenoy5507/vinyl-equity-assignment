import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig, parseCli, usage } from "./config.js";
import { loadMockIssue } from "./issues/mock-source.js";
import { loadGitHubIssue } from "./issues/github-source.js";
import { GeminiAgent } from "./agents/gemini.js";
import { generateScenarioPlan, selectScenarios } from "./agents/planner.js";
import { executeScenario } from "./agents/executor.js";
import { revalidateScenario } from "./agents/revalidator.js";
import { exploreApplication } from "./browser/explorer.js";
import { PlaywrightMcp } from "./browser/playwright-mcp.js";
import { appendActionLog, evidenceDirectory, resetActionLog } from "./evidence/logger.js";
import { PhaseLedger } from "./evidence/phase-ledger.js";
import {
  buildAcceptanceCriteriaTrace,
  buildArtifactInventory,
  buildEnvironment,
  buildReport,
  dualWriteExistingFile,
  runEvidenceDirectory,
  writeReport,
} from "./evidence/reporter.js";
import type { NormalizedIssue, PlannedScenario, ScenarioResult } from "./schemas.js";
import { isGeminiServiceError } from "./agents/gemini-errors.js";

function plannedScenarioFields(scenario: PlannedScenario): Pick<ScenarioResult, "preconditions" | "intendedSteps" | "verificationStrategy"> {
  return {
    preconditions: [...scenario.preconditions],
    intendedSteps: scenario.steps.map((step) => ({ ...step })),
    verificationStrategy: scenario.verificationStrategy,
  };
}

function blockedScenarioFromPlan(scenario: PlannedScenario, reason: string, observed: string): ScenarioResult {
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
    status: "BLOCKED",
    expected: scenario.expectedResult,
    observed,
    reason,
    evidence: [],
    actionCount: 0,
    recoveryCount: 0,
    ...plannedScenarioFields(scenario),
  };
}

async function finalizeAndWriteReport(input: {
  ledger: PhaseLedger;
  runId: string;
  source: "mock" | "github";
  model: string;
  issueNumber: number;
  issueTitle: string;
  targetUrl: string;
  startedAt: string;
  scenarios: ScenarioResult[];
  acceptanceCriteria?: NormalizedIssue["acceptanceCriteria"];
  blocker?: string;
  headless?: boolean;
  knownArtifacts?: Array<{ label: string; path: string }>;
}): Promise<{ status: ScenarioResult["status"]; totals: Record<ScenarioResult["status"], number> }> {
  input.ledger.start(6);
  const completedAt = new Date().toISOString();
  const runDir = runEvidenceDirectory(input.runId);
  const reportJsonPath = resolve(runDir, "report.json");
  const reportMdPath = resolve(runDir, "report.md");
  const rootReportJson = resolve(evidenceDirectory, "report.json");
  const rootReportMd = resolve(evidenceDirectory, "report.md");
  input.ledger.complete(6, "COMPLETED", {
    completedAt,
    outputArtifacts: [reportJsonPath, reportMdPath, rootReportJson, rootReportMd],
  });
  const candidates = [
    ...(input.knownArtifacts ?? []),
    { label: "Run report JSON", path: reportJsonPath },
    { label: "Run report Markdown", path: reportMdPath },
    { label: "Latest report JSON", path: rootReportJson },
    { label: "Latest report Markdown", path: rootReportMd },
    { label: "Action log (latest)", path: resolve(evidenceDirectory, "action-log.ndjson") },
    { label: "Action log (run)", path: resolve(runDir, "action-log.ndjson") },
  ];
  // Reports are about to be written; mark them available in the inventory that ships inside the report.
  const artifacts = (await buildArtifactInventory(candidates)).map((artifact) =>
    artifact.path === reportJsonPath
      || artifact.path === reportMdPath
      || artifact.path === rootReportJson
      || artifact.path === rootReportMd
      ? { ...artifact, available: true }
      : artifact);
  const report = buildReport({
    runId: input.runId,
    source: input.source,
    model: input.model,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    targetUrl: input.targetUrl,
    startedAt: input.startedAt,
    completedAt,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    scenarios: input.scenarios,
    phases: input.ledger.summaries(),
    ...(input.acceptanceCriteria
      ? { acceptanceCriteria: buildAcceptanceCriteriaTrace(input.acceptanceCriteria, input.scenarios) }
      : {}),
    artifacts,
    environment: buildEnvironment(input.headless),
  });
  await writeReport(report);
  return { status: report.status, totals: report.totals };
}

export async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const config = readConfig();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const ledger = new PhaseLedger();
  const runDir = runEvidenceDirectory(runId);
  await resetActionLog();
  await mkdir(runDir, { recursive: true });

  const applicationContextPath = resolve(runDir, "application-context.json");
  const generatedScenariosPath = resolve(runDir, "generated-scenarios.json");

  ledger.start(1);
  let issue: NormalizedIssue;
  try {
    if (cli.source === "mock") {
      issue = await loadMockIssue();
    } else {
      if (!cli.repo || !cli.issue) throw new Error("GitHub mode requires --repo=owner/repository and --issue=NUMBER.");
      issue = await loadGitHubIssue(cli.repo, cli.issue, config.GITHUB_TOKEN);
    }
    ledger.complete(1, "COMPLETED");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ledger.complete(1, "FAILED", { errors: [message] });
    ledger.markRemainingNotRun(2, "Requirement discovery failed before downstream phases.");
    await appendActionLog({ timestamp: new Date().toISOString(), runId, event: "issue_ingestion_error", message });
    await finalizeAndWriteReport({
      ledger,
      runId,
      source: cli.source,
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      issueNumber: cli.issue ?? 0,
      issueTitle: "Issue ingestion failed",
      targetUrl: process.env.TARGET_URL ?? "https://demo.playwright.dev/todomvc/",
      startedAt,
      blocker: message,
      headless: config.HEADLESS,
      scenarios: [{
        scenarioId: "ISSUE-INGESTION",
        title: "Issue ingestion",
        acceptanceCriteriaIds: [],
        status: "BLOCKED",
        expected: "A valid normalized issue is available.",
        observed: "Issue validation/ingestion failed.",
        reason: message,
        evidence: [],
        actionCount: 0,
        recoveryCount: 0,
      }],
    });
    process.stderr.write(`${message}\n`);
    return 1;
  }

  if (issue.status !== "RFQA") {
    ledger.markRemainingNotRun(2, "Issue was not RFQA; Gemini and browser phases were not started.");
    const results: ScenarioResult[] = [{
      scenarioId: "READINESS",
      title: "RFQA readiness guard",
      acceptanceCriteriaIds: issue.acceptanceCriteria.map((criterion) => criterion.id),
      status: "SKIPPED",
      expected: "Issue has the RFQA label/status.",
      observed: `Issue status is ${issue.status}.`,
      reason: "Readiness guard prevented Gemini and browser startup.",
      evidence: [],
      actionCount: 0,
      recoveryCount: 0,
    }];
    await finalizeAndWriteReport({
      ledger,
      runId,
      source: cli.source,
      model: config.GEMINI_MODEL,
      issueNumber: issue.issueNumber,
      issueTitle: issue.title,
      targetUrl: issue.targetUrl,
      startedAt,
      scenarios: results,
      acceptanceCriteria: issue.acceptanceCriteria,
      headless: config.HEADLESS,
    });
    process.stdout.write(`Issue is not RFQA; skipped before Gemini/browser. Report: evidence/report.md\n`);
    return 0;
  }

  ledger.start(2);
  const applicationContext = await exploreApplication({
    targetUrl: issue.targetUrl,
    runId,
    headless: config.HEADLESS,
    outputPath: applicationContextPath,
  });
  await dualWriteExistingFile(runId, applicationContextPath, "application-context.json");
  const applicationContextArtifacts = [
    applicationContextPath,
    resolve(evidenceDirectory, "application-context.json"),
    ...(applicationContext.evidence.screenshot
      ? [resolve(evidenceDirectory, applicationContext.evidence.screenshot)]
      : []),
  ];
  if (applicationContext.status === "BLOCKED") {
    const reason = applicationContext.diagnostics.map(({ stage, message }) => `${stage}: ${message}`).join("; ");
    ledger.complete(2, "BLOCKED", { outputArtifacts: applicationContextArtifacts, errors: [reason] });
    ledger.markRemainingNotRun(3, "Application exploration was blocked.");
    await finalizeAndWriteReport({
      ledger,
      runId,
      source: cli.source,
      model: config.GEMINI_MODEL,
      issueNumber: issue.issueNumber,
      issueTitle: issue.title,
      targetUrl: issue.targetUrl,
      startedAt,
      blocker: `Application exploration was blocked. ${reason}`,
      acceptanceCriteria: issue.acceptanceCriteria,
      headless: config.HEADLESS,
      knownArtifacts: [
        { label: "Application context (run)", path: applicationContextPath },
        { label: "Application context (latest)", path: resolve(evidenceDirectory, "application-context.json") },
      ],
      scenarios: [{
        scenarioId: "APPLICATION-EXPLORATION",
        title: "Phase 2 application exploration",
        acceptanceCriteriaIds: [],
        status: "BLOCKED",
        expected: "Capture the target page title, current URL, accessibility snapshot, semantic controls, and screenshot.",
        observed: applicationContext.page.accessibilitySnapshot === null
          ? "No valid accessibility snapshot was captured."
          : "Page observations were captured, but exploration did not complete successfully.",
        reason,
        evidence: applicationContext.evidence.screenshot
          ? [resolve(evidenceDirectory, applicationContext.evidence.screenshot)]
          : [],
        actionCount: 0,
        recoveryCount: 0,
      }],
    });
    process.stderr.write(`Run BLOCKED during application exploration. ${reason}\n`);
    return 1;
  }
  ledger.complete(2, "COMPLETED", { outputArtifacts: applicationContextArtifacts });

  const screenshotDirectory = resolve(evidenceDirectory, "screenshots", runId);
  let results: ScenarioResult[] = [];
  let blocker: string | undefined;
  let plannedScenarios: PlannedScenario[] = [];
  let agent: GeminiAgent | undefined;
  let revalidationExecuted = false;
  let planningCompleted = false;
  let executionStarted = false;

  try {
    await mkdir(screenshotDirectory, { recursive: true });
    ledger.start(3);
    agent = new GeminiAgent(config.GEMINI_API_KEY, config.GEMINI_MODEL, { runId });
    const generatedPlan = await generateScenarioPlan(agent, issue, applicationContext, runId, {
      artifactPath: generatedScenariosPath,
      applicationContextPath: relativeEvidencePath(applicationContextPath),
    });
    await dualWriteExistingFile(runId, generatedScenariosPath, "generated-scenarios.json");
    ledger.complete(3, "COMPLETED", {
      outputArtifacts: [generatedScenariosPath, resolve(evidenceDirectory, "generated-scenarios.json")],
    });
    planningCompleted = true;

    const scenariosToRun = selectScenarios(generatedPlan.scenarios, cli.scenario);
    plannedScenarios = scenariosToRun;
    ledger.start(4);
    executionStarted = true;
    let geminiServiceFailed = false;
    for (const [index, scenario] of scenariosToRun.entries()) {
      let browser: PlaywrightMcp | undefined;
      let browserClosedCleanly = true;
      try {
        browser = new PlaywrightMcp(config.HEADLESS);
        const discovered = await browser.connect();
        await appendActionLog({
          timestamp: new Date().toISOString(),
          runId,
          scenarioId: scenario.id,
          event: "mcp_tools_discovered",
          tools: discovered.map(({ name, inputSchema }) => ({ name, inputSchema })),
        });
        const result = await executeScenario({
          agent,
          browser,
          issue,
          scenario,
          runId,
          scenarioIndex: index + 1,
          screenshotDirectory,
          limits: {
            maxActions: config.MAX_ACTIONS_PER_SCENARIO,
            maxModelRequests: config.MAX_EXECUTOR_REQUESTS_PER_SCENARIO,
            maxSeconds: config.MAX_SCENARIO_SECONDS,
            maxRecoveryRetries: config.MAX_RECOVERY_RETRIES,
            requestTimeoutMs: config.GEMINI_EXECUTOR_TIMEOUT_MS,
          },
        });
        results.push(result);
        geminiServiceFailed = result.status === "BLOCKED" && isGeminiServiceError(result.reason);
        if (geminiServiceFailed) blocker = `Gemini service request failed; remaining scenarios were not attempted. ${result.reason}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        blocker = blocker ? `${blocker}; ${scenario.id}: ${message}` : `${scenario.id}: ${message}`;
        geminiServiceFailed = isGeminiServiceError(error);
        await appendActionLog({ timestamp: new Date().toISOString(), runId, scenarioId: scenario.id, event: "scenario_infrastructure_error", message });
        results.push(blockedScenarioFromPlan(scenario, message, "No reliable browser execution was completed."));
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch (error) {
            browserClosedCleanly = false;
            const message = `Could not cleanly close ${scenario.id} browser: ${error instanceof Error ? error.message : String(error)}`;
            blocker = blocker ? `${blocker}; ${message}` : message;
            await appendActionLog({ timestamp: new Date().toISOString(), runId, scenarioId: scenario.id, event: "browser_close_error", message });
          }
        }
      }
      if (geminiServiceFailed) {
        for (const skippedScenario of scenariosToRun.slice(index + 1)) {
          results.push(blockedScenarioFromPlan(
            skippedScenario,
            "Gemini service request failed; no further scenarios were attempted.",
            "Execution stopped before browser verification.",
          ));
        }
        break;
      }
      const initialResult = results[results.length - 1];
      if (browserClosedCleanly && agent && initialResult?.status === "FAIL" && initialResult.hostVerifiedFailure === true) {
        if (!revalidationExecuted) ledger.start(5);
        results[results.length - 1] = await revalidateScenario({
          agent,
          createBrowser: () => new PlaywrightMcp(config.HEADLESS),
          issue,
          scenario,
          originalResult: initialResult,
          originalRunId: runId,
          scenarioIndex: index + 1,
          screenshotDirectory,
          limits: {
            maxActions: config.MAX_ACTIONS_PER_SCENARIO,
            maxModelRequests: config.MAX_EXECUTOR_REQUESTS_PER_SCENARIO,
            maxSeconds: config.MAX_SCENARIO_SECONDS,
            maxRecoveryRetries: config.MAX_RECOVERY_RETRIES,
            requestTimeoutMs: config.GEMINI_EXECUTOR_TIMEOUT_MS,
          },
        });
        revalidationExecuted = true;
      }
    }
    const executionBlockers = results.filter((result) => result.status === "BLOCKED");
    const executionErrors = [...new Set([
      ...(blocker ? [blocker] : []),
      ...executionBlockers.map((result) => `${result.scenarioId}: ${result.reason}`),
    ])];
    ledger.complete(4, executionErrors.length > 0 ? "BLOCKED" : "COMPLETED", {
      outputArtifacts: [screenshotDirectory, resolve(runDir, "action-log.ndjson")],
      ...(executionErrors.length > 0 ? { errors: executionErrors } : {}),
    });
    if (revalidationExecuted) {
      ledger.complete(5, "COMPLETED");
    } else {
      ledger.markNotRun(5, "No host-verified functional failure; revalidation was not required.");
    }
  } catch (error) {
    blocker = error instanceof Error ? error.message : String(error);
    if (isGeminiServiceError(error)) blocker = `Gemini service request failed; no further scenarios were attempted. ${blocker}`;
    await appendActionLog({ timestamp: new Date().toISOString(), runId, event: "infrastructure_error", message: blocker });
    process.stderr.write(`Run blocked: ${blocker}\n`);
    if (!planningCompleted) {
      const status = isGeminiServiceError(error) ? "BLOCKED" as const : "FAILED" as const;
      ledger.complete(3, status, { errors: [blocker] });
      ledger.markRemainingNotRun(4, "Scenario generation did not complete.");
    } else if (executionStarted) {
      ledger.complete(4, isGeminiServiceError(error) ? "BLOCKED" : "FAILED", { errors: [blocker] });
      if (!revalidationExecuted) {
        ledger.markNotRun(5, "Execution failed before revalidation could run.");
      }
    }
  }

  if (results.length === 0) {
    results = plannedScenarios.length > 0
      ? plannedScenarios.map((scenario) => blockedScenarioFromPlan(
        scenario,
        blocker ?? "Scenario execution did not start.",
        "No browser execution occurred.",
      ))
      : issue.acceptanceCriteria.map((criterion, index) => ({
        scenarioId: `UNPLANNED-${String(index + 1).padStart(2, "0")}`,
        title: `Unverified: ${criterion.id}`,
        acceptanceCriteriaIds: [criterion.id],
        status: "BLOCKED" as const,
        expected: criterion.description,
        observed: "No browser execution occurred.",
        reason: blocker ?? "The scenario plan could not be generated.",
        evidence: [],
        actionCount: 0,
        recoveryCount: 0,
      }));
  }

  // Ensure Phase 5 is explicitly marked when planning/execution paths skipped the revalidation branch.
  const phase5 = ledger.summaries().find((phase) => phase.phase === 5);
  if (phase5 && phase5.status === "NOT_RUN" && phase5.errors.length === 0 && planningCompleted) {
    ledger.markNotRun(5, "No host-verified functional failure; revalidation was not required.");
  }

  const { status, totals } = await finalizeAndWriteReport({
    ledger,
    runId,
    source: cli.source,
    model: config.GEMINI_MODEL,
    issueNumber: issue.issueNumber,
    issueTitle: issue.title,
    targetUrl: issue.targetUrl,
    startedAt,
    ...(blocker ? { blocker } : {}),
    scenarios: results,
    acceptanceCriteria: issue.acceptanceCriteria,
    headless: config.HEADLESS,
    knownArtifacts: [
      { label: "Application context (run)", path: applicationContextPath },
      { label: "Application context (latest)", path: resolve(evidenceDirectory, "application-context.json") },
      { label: "Generated scenarios (run)", path: generatedScenariosPath },
      { label: "Generated scenarios (latest)", path: resolve(evidenceDirectory, "generated-scenarios.json") },
      { label: "Screenshots directory", path: screenshotDirectory },
    ],
  });
  process.stdout.write(`Run ${status}: PASS ${totals.PASS}, FAIL ${totals.FAIL}, BLOCKED ${totals.BLOCKED}, SKIPPED ${totals.SKIPPED}\n`);
  process.stdout.write(`Evidence: ${resolve(evidenceDirectory, "report.md")}\n`);
  process.stdout.write(`Run evidence: ${resolve(runDir, "report.md")}\n`);
  return status === "PASS" || status === "SKIPPED" ? 0 : 1;
}

function relativeEvidencePath(absolutePath: string): string {
  const fromCwd = relative(process.cwd(), absolutePath).replaceAll("\\", "/");
  return fromCwd.startsWith("..") ? absolutePath.replaceAll("\\", "/") : fromCwd;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(`Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
