import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  NormalizedIssue,
  PlannedScenario,
  RevalidationClassification,
  ScenarioResult,
} from "../schemas.js";
import type { DiscoveredTool } from "../browser/tool-policy.js";
import { appendActionLog } from "../evidence/logger.js";
import { executeScenario, type BrowserAgent, type JsonAgent } from "./executor.js";

export interface RevalidationBrowser extends BrowserAgent {
  connect(): Promise<DiscoveredTool[]>;
  close(): Promise<void>;
}

export interface RevalidatorInput {
  agent: JsonAgent;
  createBrowser: (runId: string) => RevalidationBrowser;
  issue: NormalizedIssue;
  scenario: PlannedScenario;
  originalResult: ScenarioResult;
  originalRunId: string;
  scenarioIndex: number;
  screenshotDirectory: string;
  limits: {
    maxActions: number;
    maxModelRequests?: number;
    maxSeconds: number;
    maxRecoveryRetries: number;
    requestTimeoutMs?: number;
  };
}

const attemptedRevalidations = new Set<string>();
const nonRepeatableActionPattern = /\b(delete|remove|erase|destroy|drop|purchase|buy|pay|payment|charge|transfer|send(?:ing)?\s+(?:an?\s+)?(?:email|message|invitation)|close\s+(?:an?\s+)?account)\b/i;

function withoutRevalidation(result: ScenarioResult): Omit<ScenarioResult, "revalidation"> {
  const { revalidation: _revalidation, ...original } = result;
  return original;
}

function classify(status: ScenarioResult["status"]): RevalidationClassification {
  if (status === "FAIL") return "CONFIRMED_FAILURE";
  if (status === "PASS") return "FLAKY_OR_INCONSISTENT";
  return "REVALIDATION_INCONCLUSIVE";
}

function scenarioMayBeIrreversible(input: RevalidatorInput): boolean {
  const scenarioText = [
    input.scenario.title,
    input.scenario.expectedResult,
    input.scenario.verificationStrategy,
    ...input.scenario.preconditions,
    ...input.scenario.steps.flatMap(({ intent, expectedObservation }) => [intent, expectedObservation]),
    ...input.issue.acceptanceCriteria
      .filter(({ id }) => input.scenario.acceptanceCriteriaIds.includes(id))
      .map(({ description }) => description),
  ].join("\n");
  return input.scenario.verificationChecks.some(({ kind }) => kind === "absent_after_seen")
    || nonRepeatableActionPattern.test(scenarioText);
}

export async function revalidateScenario(input: RevalidatorInput): Promise<ScenarioResult> {
  const { originalResult, originalRunId, scenario } = input;
  if (originalResult.status !== "FAIL" || originalResult.hostVerifiedFailure !== true || originalResult.revalidation) {
    return originalResult;
  }
  if (scenarioMayBeIrreversible(input)) {
    await appendActionLog({
      timestamp: new Date().toISOString(),
      runId: originalRunId,
      scenarioId: scenario.id,
      event: "revalidation_skipped_non_repeatable_scenario",
      reason: "The scenario describes a destructive or potentially irreversible action; Phase 5 will not repeat it.",
    });
    return originalResult;
  }

  const attemptKey = `${originalRunId}:${scenario.id}`;
  if (attemptedRevalidations.has(attemptKey)) return originalResult;
  attemptedRevalidations.add(attemptKey);

  const revalidationRunId = `${originalRunId}-revalidation-${randomUUID()}`;
  const original = withoutRevalidation(originalResult);
  const safeScenarioId = scenario.id.replace(/[^A-Za-z0-9_-]/g, "_");
  const attemptDirectory = resolve(input.screenshotDirectory, "revalidation", safeScenarioId);
  let browser: RevalidationBrowser | undefined;
  let attemptResult: ScenarioResult;

  await appendActionLog({
    timestamp: new Date().toISOString(),
    runId: revalidationRunId,
    originalRunId,
    scenarioId: scenario.id,
    event: "revalidation_started",
    attemptCount: 1,
    originalFailureReason: original.reason,
  });

  try {
    await mkdir(attemptDirectory, { recursive: true });
    browser = input.createBrowser(revalidationRunId);
    const discoveredTools = await browser.connect();
    await appendActionLog({
      timestamp: new Date().toISOString(),
      runId: revalidationRunId,
      originalRunId,
      scenarioId: scenario.id,
      event: "revalidation_mcp_tools_discovered",
      tools: discoveredTools,
    });
    attemptResult = await executeScenario({
      agent: input.agent,
      browser,
      issue: input.issue,
      scenario,
      runId: revalidationRunId,
      scenarioIndex: input.scenarioIndex,
      screenshotDirectory: attemptDirectory,
      limits: input.limits,
    });
  } catch (error) {
    const reason = `Revalidation could not complete: ${error instanceof Error ? error.message : String(error)}`;
    attemptResult = {
      scenarioId: scenario.id,
      title: scenario.title,
      acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
      status: "BLOCKED",
      expected: scenario.expectedResult,
      observed: "No reliable revalidation browser execution was completed.",
      reason,
      evidence: [],
      actionCount: 0,
      recoveryCount: 0,
    };
    await appendActionLog({
      timestamp: new Date().toISOString(),
      runId: revalidationRunId,
      originalRunId,
      scenarioId: scenario.id,
      event: "revalidation_error",
      message: reason,
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        await appendActionLog({
          timestamp: new Date().toISOString(),
          runId: revalidationRunId,
          originalRunId,
          scenarioId: scenario.id,
          event: "revalidation_browser_close_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const classification = classify(attemptResult.status);
  const revalidation = {
    originalRunId,
    revalidationRunId,
    attemptCount: 1 as const,
    originalFailureReason: original.reason,
    originalResult: original,
    attemptResult: withoutRevalidation(attemptResult),
    classification,
  };
  await appendActionLog({
    timestamp: new Date().toISOString(),
    runId: revalidationRunId,
    originalRunId,
    scenarioId: scenario.id,
    event: "revalidation_completed",
    attemptCount: 1,
    classification,
    originalStatus: original.status,
    revalidationStatus: attemptResult.status,
    actionCount: attemptResult.actionCount,
    recoveryCount: attemptResult.recoveryCount,
    screenshotEvidence: attemptResult.evidence,
  });

  return { ...originalResult, revalidation };
}
