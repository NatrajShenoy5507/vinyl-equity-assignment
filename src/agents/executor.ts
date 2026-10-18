import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { executorDecisionSchema, type ExecutorDecision, type NormalizedIssue, type PlannedScenario, type ScenarioResult } from "../schemas.js";
import { executorPrompt } from "../prompts/executor-prompt.js";
import { getPermittedTools, validateToolAction, type DiscoveredTool } from "../browser/tool-policy.js";
import { appendActionLog } from "../evidence/logger.js";
import { isGeminiServiceError } from "./gemini-errors.js";

export interface JsonAgent {
  generateJson(prompt: string, schema: Record<string, unknown>, timeoutMs?: number, requestKind?: "planner" | "executor"): Promise<unknown>;
}

export interface BrowserAgent {
  readonly discoveredTools: DiscoveredTool[];
  call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<{ text: string; isError: boolean; raw: unknown }>;
  screenshot(filePath: string, timeoutMs?: number): Promise<void>;
}

interface ExecutorLimits {
  maxActions: number;
  maxSeconds: number;
  maxRecoveryRetries: number;
}

function decisionJsonSchema(tools: DiscoveredTool[], onlyToolName?: string): Record<string, unknown> {
  const finishDecision = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["finish"] },
      assessments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            acceptanceCriteriaId: { type: "string" },
            meets: { type: "boolean" },
            observedEvidence: { type: "string" },
            explanation: { type: "string" },
          },
          required: ["acceptanceCriteriaId", "meets", "observedEvidence", "explanation"],
          additionalProperties: false,
        },
      },
      rationale: { type: "string" },
    },
    required: ["kind", "assessments", "rationale"],
    additionalProperties: false,
  };
  const actionDecisions = tools
    .filter((tool) => onlyToolName === undefined || tool.name === onlyToolName)
    .map((tool) => ({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["action"] },
        toolName: { type: "string", enum: [tool.name] },
        arguments: {
          type: "object",
          properties: tool.inputSchema.properties ?? {},
          required: tool.inputSchema.required ?? [],
          additionalProperties: false,
        },
        rationale: { type: "string" },
      },
      required: ["kind", "toolName", "arguments", "rationale"],
      additionalProperties: false,
    }));
  return { type: "object", anyOf: [finishDecision, ...actionDecisions] };
}

export interface ExecuteInput {
  agent: JsonAgent;
  browser: BrowserAgent;
  issue: NormalizedIssue;
  scenario: PlannedScenario;
  runId: string;
  scenarioIndex: number;
  screenshotDirectory: string;
  limits: ExecutorLimits;
}

function textFromTool(result: { text: string; raw: unknown }): string {
  return result.text || JSON.stringify(result.raw);
}

function parseDecision(value: unknown): ExecutorDecision {
  const parsed = executorDecisionSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Gemini executor response failed validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  return parsed.data;
}

function blockedResult(scenario: PlannedScenario, issue: NormalizedIssue, reason: string, actionCount: number, recoveryCount: number, evidence: string[]): ScenarioResult {
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
    status: "BLOCKED",
    expected: scenario.expectedResult,
    observed: "The scenario could not be verified.",
    reason,
    evidence,
    actionCount,
    recoveryCount,
  };
}

function verifySnapshotOrigin(snapshot: string, targetUrl: string): void {
  const pageUrl = snapshot.match(/^\s*-\s*Page URL:\s*(\S+)\s*$/m)?.[1];
  if (!pageUrl) throw new Error("Browser snapshot omitted its current page URL; origin cannot be verified.");
  const expectedOrigin = new URL(targetUrl).origin;
  const actualOrigin = new URL(pageUrl).origin;
  if (actualOrigin !== expectedOrigin) throw new Error(`Browser navigated outside the allowed target origin: ${actualOrigin}`);
}

export async function executeScenario(input: ExecuteInput): Promise<ScenarioResult> {
  const { agent, browser, issue, scenario, runId, scenarioIndex, screenshotDirectory, limits } = input;
  const deadline = Date.now() + limits.maxSeconds * 1000;
  const evidence: string[] = [];
  const history: Array<{ toolName: string; result: string }> = [];
  let actionCount = 0;
  let screenshotCount = 0;
  let recoveryCount = 0;
  let latestSnapshot = "";
  let invalidActionFeedback: string | undefined;
  let rejectedToolName: string | undefined;
  let previousActionKey = "";
  let unchangedActionCount = 0;
  const tools = getPermittedTools(browser.discoveredTools);
  const uniqueTaskText = `QA-${runId}-${scenario.id}`;
  const screenshot = async () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Scenario time limit reached before screenshot capture.");
    screenshotCount += 1;
    const path = resolve(screenshotDirectory, `${scenario.id}-${String(screenshotCount).padStart(2, "0")}.png`);
    await browser.screenshot(path, Math.min(20_000, remainingMs));
    await access(path);
    evidence.push(path);
  };
  const record = async (data: Record<string, unknown>) => appendActionLog({ timestamp: new Date().toISOString(), runId, scenarioId: scenario.id, acceptanceCriteriaIds: scenario.acceptanceCriteriaIds, ...data });

  try {
    const navigation = await browser.call("browser_navigate", { url: issue.targetUrl });
    if (navigation.isError) throw new Error(`Navigation failed: ${navigation.text}`);
    await record({ toolName: "browser_navigate", arguments: { url: issue.targetUrl }, result: navigation.text.slice(0, 1500), rationale: "Open target application for isolated scenario." });
    const initial = await browser.call("browser_snapshot");
    if (initial.isError || initial.text.trim().length === 0) throw new Error(`Initial browser snapshot unavailable: ${initial.text}`);
    latestSnapshot = initial.text;
    verifySnapshotOrigin(latestSnapshot, issue.targetUrl);
    history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
    await record({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 1500), rationale: "Observe accessible page state before acting." });
    await screenshot();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await record({ toolName: "browser_initialization", status: "error", result: reason });
    return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
  }

  while (Date.now() < deadline) {
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return blockedResult(scenario, issue, "Scenario time limit reached before the next Gemini decision.", actionCount, recoveryCount, evidence);
      const proposed = await agent.generateJson(executorPrompt({
        issue,
        scenario,
        snapshot: latestSnapshot,
        history,
        uniqueTaskText,
        availableTools: tools.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
        invalidActionFeedback,
      }), decisionJsonSchema(tools, rejectedToolName), Math.min(30_000, remainingMs), "executor");
      const decision = parseDecision(proposed);
      if (decision.kind === "finish") {
        const assessments = new Map(decision.assessments.map((assessment) => [assessment.acceptanceCriteriaId, assessment]));
        const unknown = decision.assessments.find((assessment) => !scenario.acceptanceCriteriaIds.includes(assessment.acceptanceCriteriaId));
        if (unknown) throw new Error(`Gemini assessed unrelated criterion ${unknown.acceptanceCriteriaId}.`);
        const missing = scenario.acceptanceCriteriaIds.filter((id) => !assessments.has(id));
        if (missing.length > 0) return blockedResult(scenario, issue, `Final evidence omitted criteria: ${missing.join(", ")}.`, actionCount, recoveryCount, evidence);
        const unproven = decision.assessments.find((assessment) =>
          !history.some((observation) => observation.result.includes(assessment.observedEvidence)));
        if (unproven) return blockedResult(scenario, issue, `The claimed evidence for ${unproven.acceptanceCriteriaId} does not exactly match any observed browser result.`, actionCount, recoveryCount, evidence);
        await screenshot();
        const failed = decision.assessments.find((assessment) => !assessment.meets);
        const status = failed ? "FAIL" : evidence.length > 0 ? "PASS" : "BLOCKED";
        const result: ScenarioResult = {
          scenarioId: scenario.id,
          title: scenario.title,
          acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
          status,
          expected: scenario.expectedResult,
          observed: decision.assessments.map((item) => `${item.acceptanceCriteriaId}: ${item.observedEvidence}`).join("\n"),
          reason: failed ? `${failed.acceptanceCriteriaId} contradicted by observed state: ${failed.explanation}` : decision.rationale,
          evidence,
          actionCount,
          recoveryCount,
        };
        await record({ toolName: "assertion", status, assessments: decision.assessments, rationale: decision.rationale });
        return result;
      }

      if (actionCount >= limits.maxActions) return blockedResult(scenario, issue, "Maximum model-selected browser action budget exhausted.", actionCount, recoveryCount, evidence);
      let args: Record<string, unknown>;
      try {
        args = validateToolAction(decision.toolName, decision.arguments, browser.discoveredTools, issue.targetUrl);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await record({ toolName: decision.toolName, status: "rejected", arguments: decision.arguments, result: reason, rationale: decision.rationale });
        if (recoveryCount >= limits.maxRecoveryRetries) return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
        recoveryCount += 1;
        invalidActionFeedback = reason;
        rejectedToolName = decision.toolName;
        continue;
      }
      invalidActionFeedback = undefined;
      rejectedToolName = undefined;
      const targetReference = typeof args.target === "string" ? args.target : typeof args.ref === "string" ? args.ref : undefined;
      if (targetReference && !latestSnapshot.includes(`[ref=${targetReference}]`)) {
        const message = `Element reference ${targetReference} is not present in the latest accessibility snapshot.`;
        await record({ toolName: decision.toolName, status: "stale_reference", arguments: args, result: message, rationale: decision.rationale });
        if (recoveryCount >= limits.maxRecoveryRetries) return blockedResult(scenario, issue, `${message} Recovery limit reached.`, actionCount, recoveryCount, evidence);
        recoveryCount += 1;
        const refreshed = await browser.call("browser_snapshot", {}, Math.min(20_000, Math.max(1, deadline - Date.now())));
        if (refreshed.isError || !refreshed.text.trim()) return blockedResult(scenario, issue, `Recovery snapshot failed: ${refreshed.text}`, actionCount, recoveryCount, evidence);
        latestSnapshot = refreshed.text;
        verifySnapshotOrigin(latestSnapshot, issue.targetUrl);
        history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
        await screenshot();
        continue;
      }
      const actionKey = `${decision.toolName}:${JSON.stringify(args)}:${latestSnapshot}`;
      if (actionKey === previousActionKey) unchangedActionCount += 1;
      else unchangedActionCount = 0;
      if (unchangedActionCount >= 1) return blockedResult(scenario, issue, "Repeated identical action against an unchanged snapshot; stopped to prevent an interaction loop.", actionCount, recoveryCount, evidence);
      previousActionKey = actionKey;

      actionCount += 1;
      const toolResult = await browser.call(decision.toolName, args, Math.min(20_000, Math.max(1000, deadline - Date.now())));
      await record({
        toolName: decision.toolName,
        arguments: args,
        status: toolResult.isError ? "error" : "ok",
        result: toolResult.text.slice(0, 2000),
        rationale: decision.rationale,
      });
      if (toolResult.isError) {
        if (recoveryCount >= limits.maxRecoveryRetries) return blockedResult(scenario, issue, `Browser interaction failed after ${recoveryCount} recovery retries: ${toolResult.text}`, actionCount, recoveryCount, evidence);
        recoveryCount += 1;
        const refreshed = await browser.call("browser_snapshot");
        if (refreshed.isError || !refreshed.text.trim()) return blockedResult(scenario, issue, `Recovery snapshot failed: ${refreshed.text}`, actionCount, recoveryCount, evidence);
        latestSnapshot = refreshed.text;
        verifySnapshotOrigin(latestSnapshot, issue.targetUrl);
        history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
        await screenshot();
        continue;
      }
      history.push({ toolName: decision.toolName, result: textFromTool(toolResult).slice(0, 4000) });
      const observation = await browser.call("browser_snapshot");
      if (observation.isError || !observation.text.trim()) return blockedResult(scenario, issue, `Post-action observation failed: ${observation.text}`, actionCount, recoveryCount, evidence);
      latestSnapshot = observation.text;
      verifySnapshotOrigin(latestSnapshot, issue.targetUrl);
      history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
      await record({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 1500), rationale: `Observe result after ${decision.toolName}.` });
      await screenshot();
      if (Date.now() >= deadline) return blockedResult(scenario, issue, "Scenario time limit reached before all criteria were verified.", actionCount, recoveryCount, evidence);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const serviceFailure = isGeminiServiceError(error);
      await record({ toolName: "executor", status: serviceFailure ? "service_error" : "error", result: reason });
      return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
    }
  }
  const reason = Date.now() >= deadline ? "Scenario time limit reached." : "Maximum browser action budget exhausted.";
  await record({ toolName: "executor", status: "blocked", result: reason });
  return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
}
