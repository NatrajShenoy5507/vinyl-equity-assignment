import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readConfig, parseCli, usage } from "./config.js";
import { loadMockIssue } from "./issues/mock-source.js";
import { loadGitHubIssue } from "./issues/github-source.js";
import { GeminiAgent } from "./agents/gemini.js";
import { createScenarioPlan, selectScenarios } from "./agents/planner.js";
import { executeScenario } from "./agents/executor.js";
import { PlaywrightMcp } from "./browser/playwright-mcp.js";
import { appendActionLog, evidenceDirectory, resetActionLog } from "./evidence/logger.js";
import { buildReport, writeReport } from "./evidence/reporter.js";
import type { NormalizedIssue, PlannedScenario, ScenarioResult } from "./schemas.js";
import { isGeminiServiceError } from "./agents/gemini-errors.js";

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const config = readConfig();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  await resetActionLog();

  let issue: NormalizedIssue;
  try {
    if (cli.source === "mock") {
      issue = await loadMockIssue();
    } else {
      if (!cli.repo || !cli.issue) throw new Error("GitHub mode requires --repo=owner/repository and --issue=NUMBER.");
      issue = await loadGitHubIssue(cli.repo, cli.issue, config.GITHUB_TOKEN);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendActionLog({ timestamp: new Date().toISOString(), runId, event: "issue_ingestion_error", message });
    const report = buildReport({
      runId,
      source: cli.source,
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      issueNumber: cli.issue ?? 0,
      issueTitle: "Issue ingestion failed",
      targetUrl: process.env.TARGET_URL ?? "https://demo.playwright.dev/todomvc/",
      startedAt,
      completedAt: new Date().toISOString(),
      blocker: message,
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
    await writeReport(report);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  if (issue.status !== "RFQA") {
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
    const report = buildReport({
      runId, source: cli.source, model: config.GEMINI_MODEL, issueNumber: issue.issueNumber,
      issueTitle: issue.title, targetUrl: issue.targetUrl, startedAt, completedAt: new Date().toISOString(), scenarios: results,
    });
    await writeReport(report);
    process.stdout.write(`Issue is not RFQA; skipped before Gemini/browser. Report: evidence/report.md\n`);
    return 0;
  }

  const screenshotDirectory = resolve(evidenceDirectory, "screenshots", runId);
  let results: ScenarioResult[] = [];
  let blocker: string | undefined;
  let plannedScenarios: PlannedScenario[] = [];
  try {
    await mkdir(screenshotDirectory, { recursive: true });
    const agent = new GeminiAgent(config.GEMINI_API_KEY, config.GEMINI_MODEL);
    const plan = await createScenarioPlan(agent, issue);
    await writeFile(resolve(evidenceDirectory, "generated-scenarios.json"), `${JSON.stringify({ runId, generatedAt: new Date().toISOString(), model: config.GEMINI_MODEL, plan }, null, 2)}\n`, "utf8");
    const scenariosToRun = selectScenarios(plan.scenarios, cli.scenario);
    plannedScenarios = scenariosToRun;
    let geminiServiceFailed = false;
    for (const [index, scenario] of scenariosToRun.entries()) {
      let browser: PlaywrightMcp | undefined;
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
            maxSeconds: config.MAX_SCENARIO_SECONDS,
            maxRecoveryRetries: config.MAX_RECOVERY_RETRIES,
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
        results.push({
          scenarioId: scenario.id,
          title: scenario.title,
          acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
          status: "BLOCKED",
          expected: scenario.expectedResult,
          observed: "No reliable browser execution was completed.",
          reason: message,
          evidence: [],
          actionCount: 0,
          recoveryCount: 0,
        });
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch (error) {
            const message = `Could not cleanly close ${scenario.id} browser: ${error instanceof Error ? error.message : String(error)}`;
            blocker = blocker ? `${blocker}; ${message}` : message;
            await appendActionLog({ timestamp: new Date().toISOString(), runId, scenarioId: scenario.id, event: "browser_close_error", message });
          }
        }
      }
      if (geminiServiceFailed) {
        for (const skippedScenario of scenariosToRun.slice(index + 1)) {
          results.push({
            scenarioId: skippedScenario.id,
            title: skippedScenario.title,
            acceptanceCriteriaIds: skippedScenario.acceptanceCriteriaIds,
            status: "BLOCKED",
            expected: skippedScenario.expectedResult,
            observed: "Execution stopped before browser verification.",
            reason: "Gemini service request failed; no further scenarios were attempted.",
            evidence: [],
            actionCount: 0,
            recoveryCount: 0,
          });
        }
        break;
      }
    }
  } catch (error) {
    blocker = error instanceof Error ? error.message : String(error);
    if (isGeminiServiceError(error)) blocker = `Gemini service request failed; no further scenarios were attempted. ${blocker}`;
    await appendActionLog({ timestamp: new Date().toISOString(), runId, event: "infrastructure_error", message: blocker });
    process.stderr.write(`Run blocked: ${blocker}\n`);
  }
  if (results.length === 0) {
    results = plannedScenarios.length > 0
      ? plannedScenarios.map((scenario) => ({
        scenarioId: scenario.id,
        title: scenario.title,
        acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
        status: "BLOCKED" as const,
        expected: scenario.expectedResult,
        observed: "No browser execution occurred.",
        reason: blocker ?? "Scenario execution did not start.",
        evidence: [],
        actionCount: 0,
        recoveryCount: 0,
      }))
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
  const report = buildReport({
    runId,
    source: cli.source,
    model: config.GEMINI_MODEL,
    issueNumber: issue.issueNumber,
    issueTitle: issue.title,
    targetUrl: issue.targetUrl,
    startedAt,
    completedAt: new Date().toISOString(),
    ...(blocker ? { blocker } : {}),
    scenarios: results,
  });
  await writeReport(report);
  process.stdout.write(`Run ${report.status}: PASS ${report.totals.PASS}, FAIL ${report.totals.FAIL}, BLOCKED ${report.totals.BLOCKED}, SKIPPED ${report.totals.SKIPPED}\n`);
  process.stdout.write(`Evidence: ${resolve(evidenceDirectory, "report.md")}\n`);
  return report.status === "PASS" || report.status === "SKIPPED" ? 0 : 1;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  process.stderr.write(`Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
