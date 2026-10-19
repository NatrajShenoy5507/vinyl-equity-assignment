import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  executorDecisionSchema,
  type ExecutorDecision,
  type NormalizedIssue,
  type PlannedScenario,
  type ScenarioBrowserAction,
  type ScenarioResult,
  type ScenarioVerification,
} from "../schemas.js";
import { executorPrompt } from "../prompts/executor-prompt.js";
import { getPermittedTools, validateToolAction, type DiscoveredTool } from "../browser/tool-policy.js";
import { appendActionLog } from "../evidence/logger.js";
import { isGeminiServiceError } from "./gemini-errors.js";

export interface JsonAgent {
  generateJson(prompt: string, schema: Record<string, unknown>, timeoutMs?: number, requestKind?: "planner" | "executor", context?: { runId?: string; scenarioId?: string }): Promise<unknown>;
}

export interface BrowserAgent {
  readonly discoveredTools: DiscoveredTool[];
  call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<{ text: string; isError: boolean; raw: unknown }>;
  screenshot(filePath: string, timeoutMs?: number): Promise<void>;
}

export interface ExecutorLimits {
  maxActions: number;
  maxModelRequests?: number;
  maxSeconds: number;
  maxRecoveryRetries: number;
  requestTimeoutMs?: number;
}

// Descriptive annotations can dominate discovered MCP schemas. Keep their actual
// constraints; exact tool-specific validation still runs locally before any call.
function compactSchema(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((child) => compactSchema(child));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => propertyMap || !["description", "title", "examples", "default", "$schema"].includes(key))
    .map(([key, child]) => [key, !propertyMap && ["enum", "const"].includes(key)
      ? child : compactSchema(child, !propertyMap && ["properties", "$defs", "definitions"].includes(key))]));
}

export function executorDecisionJsonSchema(tools: DiscoveredTool[], onlyToolName?: string): Record<string, unknown> {
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
  const availableTools = getPermittedTools(tools).filter((tool) => onlyToolName === undefined || tool.name === onlyToolName);
  if (availableTools.length === 0) return finishDecision;
  const argumentSchemas = [...new Map(availableTools.map((tool) => {
    const schema = compactSchema({
      type: "object",
      properties: tool.inputSchema.properties ?? {},
      required: tool.inputSchema.required ?? [],
      additionalProperties: false,
    }) as Record<string, unknown>;
    return [JSON.stringify(schema), schema] as const;
  })).values()];
  const actionDecision = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["action"] },
      toolName: { type: "string", enum: availableTools.map(({ name }) => name) },
      arguments: argumentSchemas.length === 1 ? argumentSchemas[0] : { anyOf: argumentSchemas },
      rationale: { type: "string" },
    },
    required: ["kind", "toolName", "arguments", "rationale"],
    additionalProperties: false,
  };
  // Share the action envelope instead of repeating it for every discovered tool.
  // The API constrains argument shapes; validateToolAction binds each shape to
  // its exact discovered tool and rejects all unknown/missing fields locally.
  return { type: "object", anyOf: [finishDecision, actionDecision] };
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

interface ObservationSnapshot {
  text: string;
  stage: "initial" | "post_action";
}

export interface VerificationCheckResult {
  acceptanceCriterionId: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  reason: string;
  evidence: string[];
}

function expandUniqueTaskText(value: string, uniqueTaskText: string): string {
  return value.replaceAll("{{uniqueTaskText}}", uniqueTaskText);
}

function checkStateNearText(snapshot: string, subject: string): "checked" | "unchecked" | "unknown" {
  const lines = snapshot.split(/\r?\n/);
  const subjectLine = lines.findIndex((line) => line.includes(subject));
  if (subjectLine < 0) return "unknown";
  const nearby = lines.slice(Math.max(0, subjectLine - 6), Math.min(lines.length, subjectLine + 7)).join("\n");
  if (/\bcheckbox\b[^\r\n]*(?:\[checked\]|\bchecked\b)|(?:\[checked\]|\bchecked\b)[^\r\n]*\bcheckbox\b/i.test(nearby)) return "checked";
  if (/\bcheckbox\b[^\r\n]*(?:\[unchecked\]|\bunchecked\b)|(?:\[unchecked\]|\bunchecked\b)[^\r\n]*\bcheckbox\b/i.test(nearby)) return "unchecked";
  return "unknown";
}

function isVisibleListItem(snapshot: string, subject: string): boolean {
  const lines = snapshot.split(/\r?\n/);
  const subjectLine = lines.findIndex((line) => line.includes(subject));
  if (subjectLine < 0) return false;
  if (/^\s*-\s+listitem\b/i.test(lines[subjectLine]!)) return true;
  const subjectIndent = lines[subjectLine]!.match(/^\s*/)?.[0].length ?? 0;
  for (let index = subjectLine; index >= 0; index -= 1) {
    const role = lines[index]!.match(/^(\s*)-\s+([a-z][\w-]*)\b/i);
    if (!role) continue;
    const roleIndent = role[1]!.length;
    if (roleIndent >= subjectIndent && index !== subjectLine) continue;
    return role[2]!.toLowerCase() === "listitem";
  }
  return false;
}

function hasActiveFilter(snapshot: string): boolean {
  return /(?:link|tab|button)\s+"Active"(?=[^\r\n]*(?:\[current\]|\[selected\]|\[checked\]))/i.test(snapshot);
}

export function verifyScenarioChecks(
  scenario: PlannedScenario,
  issue: NormalizedIssue,
  uniqueTaskText: string,
  snapshots: ObservationSnapshot[],
): VerificationCheckResult[] {
  const finalSnapshot = [...snapshots].reverse().find(({ stage }) => stage === "post_action")?.text ?? "";
  return scenario.verificationChecks.map((check) => {
    if (!scenario.acceptanceCriteriaIds.includes(check.acceptanceCriterionId)
      || !issue.acceptanceCriteria.some(({ id }) => id === check.acceptanceCriterionId)) {
      return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: "Verification check references an unknown acceptance criterion.", evidence: [] };
    }
    const expectedVisible = check.expectedVisible.map((value) => expandUniqueTaskText(value, uniqueTaskText));
    const expectedAbsent = check.expectedAbsent.map((value) => expandUniqueTaskText(value, uniqueTaskText));
    const evidence = finalSnapshot ? [finalSnapshot] : [];
    if (!finalSnapshot) {
      return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: "No post-action accessibility snapshot is available for independent verification.", evidence };
    }
    if (check.kind === "visible") {
      const missing = expectedVisible.filter((value) => !isVisibleListItem(finalSnapshot, value));
      const unexpectedlyVisible = expectedAbsent.filter((value) => isVisibleListItem(finalSnapshot, value));
      return missing.length === 0 && unexpectedlyVisible.length === 0
        ? { acceptanceCriterionId: check.acceptanceCriterionId, status: "PASS", reason: "Required content is present and prohibited content is absent in the final observation.", evidence }
        : { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: `Visible-content check is inconclusive; missing: ${missing.join(", ") || "none"}; unexpectedly visible: ${unexpectedlyVisible.join(", ") || "none"}.`, evidence };
    }
    if (check.kind === "absent_after_seen") {
      const subject = expectedVisible[0]!;
      const wasObserved = snapshots.some(({ text }) => isVisibleListItem(text, subject));
      if (!wasObserved) return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: `Cannot verify removal because "${subject}" was never observed before the final state.`, evidence };
      const remaining = expectedAbsent.filter((value) => isVisibleListItem(finalSnapshot, value));
      return remaining.length === 0
        ? { acceptanceCriterionId: check.acceptanceCriterionId, status: "PASS", reason: "The item was observed before removal and is absent in the final post-action snapshot.", evidence }
        : { acceptanceCriterionId: check.acceptanceCriterionId, status: "FAIL", reason: `The item expected to be removed is still visible: ${remaining.join(", ")}.`, evidence };
    }
    if (check.kind === "checked") {
      const subject = expectedVisible[0]!;
      if (!isVisibleListItem(finalSnapshot, subject)) return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: `Cannot verify completion because "${subject}" is not visible as a semantic list item in the final observation.`, evidence };
      const state = checkStateNearText(finalSnapshot, subject);
      if (state === "checked") return { acceptanceCriterionId: check.acceptanceCriterionId, status: "PASS", reason: "The subject is visible with a checked checkbox state in the final accessibility snapshot.", evidence };
      if (state === "unchecked") return { acceptanceCriterionId: check.acceptanceCriterionId, status: "FAIL", reason: `The subject "${subject}" is explicitly observed with an unchecked checkbox.`, evidence };
      return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: `No reliable checked/unchecked checkbox state was observed for "${subject}".`, evidence };
    }
    const priorSnapshots = snapshots.filter(({ stage }) => stage === "initial");
    const expectedItemsObserved = [...expectedVisible, ...expectedAbsent].every((value) =>
      priorSnapshots.some(({ text }) => isVisibleListItem(text, value)) || snapshots.slice(1, -1).some(({ text }) => isVisibleListItem(text, value)));
    if (!expectedItemsObserved) return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: "Filter verification requires included and excluded test items to have been observed before the final filter result.", evidence };
    if (!hasActiveFilter(finalSnapshot)) return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: "The final accessibility snapshot does not show that the Active filter is selected.", evidence };
    const missing = expectedVisible.filter((value) => !isVisibleListItem(finalSnapshot, value));
    const visibleExcluded = expectedAbsent.filter((value) => isVisibleListItem(finalSnapshot, value));
    return missing.length === 0 && visibleExcluded.length === 0
      ? { acceptanceCriterionId: check.acceptanceCriterionId, status: "PASS", reason: "The selected Active filter includes active items and excludes completed items.", evidence }
      : { acceptanceCriterionId: check.acceptanceCriterionId, status: "FAIL", reason: `Active filter contradicted expected contents; missing active items: ${missing.join(", ") || "none"}; visible completed items: ${visibleExcluded.join(", ") || "none"}.`, evidence };
  });
}

function textFromTool(result: { text: string; raw: unknown }): string {
  return result.text || JSON.stringify(result.raw);
}

function parseDecision(value: unknown): ExecutorDecision {
  const parsed = executorDecisionSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Gemini executor response failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "decision"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

function scenarioPlanFields(scenario: PlannedScenario): Pick<ScenarioResult, "preconditions" | "intendedSteps" | "verificationStrategy"> {
  return {
    preconditions: [...scenario.preconditions],
    intendedSteps: scenario.steps.map((step) => ({ ...step })),
    verificationStrategy: scenario.verificationStrategy,
  };
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
    ...scenarioPlanFields(scenario),
  };
}

function verifySnapshotOrigin(snapshot: string, targetUrl: string): void {
  const pageUrl = snapshot.match(/^\s*-\s*Page URL:\s*(\S+)\s*$/m)?.[1];
  if (!pageUrl) throw new Error("Browser snapshot omitted its current page URL; origin cannot be verified.");
  const expectedOrigin = new URL(targetUrl).origin;
  const actualOrigin = new URL(pageUrl).origin;
  if (actualOrigin !== expectedOrigin) throw new Error(`Browser navigated outside the allowed target origin: ${actualOrigin}`);
}

async function captureSnapshot(browser: BrowserAgent, issue: NormalizedIssue, deadline: number) {
  const args = validateToolAction("browser_snapshot", {}, browser.discoveredTools, issue.targetUrl);
  return browser.call("browser_snapshot", args, Math.min(20_000, Math.max(1, deadline - Date.now())));
}

interface ExecutorTrace {
  modelRequestCount: number;
  browserActions: ScenarioBrowserAction[];
  hostVerification: ScenarioVerification[];
}

async function executeScenarioInternal(input: ExecuteInput, trace: ExecutorTrace): Promise<ScenarioResult> {
  const { agent, browser, issue, scenario, runId, scenarioIndex, screenshotDirectory, limits } = input;
  const deadline = Date.now() + limits.maxSeconds * 1000;
  const evidence: string[] = [];
  const history: Array<{ toolName: string; result: string }> = [];
  const observations: ObservationSnapshot[] = [];
  let actionCount = 0;
  let modelRequestCount = 0;
  let screenshotCount = 0;
  let recoveryCount = 0;
  let latestSnapshot = "";
  let invalidActionFeedback: string | undefined;
  let rejectedToolName: string | undefined;
  let previousActionKey = "";
  let unchangedActionCount = 0;
  const tools = getPermittedTools(browser.discoveredTools);
  const uniqueTaskText = `QA-${runId}-${scenario.id}`;
  const maxModelRequests = limits.maxModelRequests ?? limits.maxActions + limits.maxRecoveryRetries + 1;
  const screenshot = async () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Scenario time limit reached before screenshot capture.");
    screenshotCount += 1;
    const path = resolve(screenshotDirectory, `${scenario.id}-${String(screenshotCount).padStart(2, "0")}.png`);
    await browser.screenshot(path, Math.min(20_000, remainingMs));
    await access(path);
    evidence.push(path);
  };
  const record = async (data: Record<string, unknown>) => appendActionLog({
    timestamp: new Date().toISOString(),
    runId,
    scenarioId: scenario.id,
    acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
    requestCount: modelRequestCount,
    ...data,
  });

  try {
    const navigationArgs = validateToolAction("browser_navigate", { url: issue.targetUrl }, browser.discoveredTools, issue.targetUrl);
    const navigation = await browser.call("browser_navigate", navigationArgs, Math.min(20_000, Math.max(1, deadline - Date.now())));
    if (navigation.isError) throw new Error(`Navigation failed: ${navigation.text}`);
    trace.browserActions.push({
      toolName: "browser_navigate",
      arguments: navigationArgs,
      rationale: "Open target application in an isolated scenario browser.",
      status: "ok",
      result: navigation.text.slice(0, 1500),
    });
    await record({ toolName: "browser_navigate", arguments: navigationArgs, result: navigation.text.slice(0, 1500), rationale: "Open target application in an isolated scenario browser." });
    const initial = await captureSnapshot(browser, issue, deadline);
    if (initial.isError || initial.text.trim().length === 0) throw new Error(`Initial browser snapshot unavailable: ${initial.text}`);
    latestSnapshot = initial.text;
    verifySnapshotOrigin(latestSnapshot, issue.targetUrl);
    history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
    observations.push({ text: latestSnapshot, stage: "initial" });
    await record({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 1500), rationale: "Observe accessible page state before acting." });
    await screenshot();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await record({ toolName: "browser_initialization", status: "error", result: reason });
    return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
  }

  while (Date.now() < deadline) {
    try {
      if (modelRequestCount >= maxModelRequests) {
        const reason = `Maximum Gemini executor request budget exhausted (${maxModelRequests}).`;
        await record({ toolName: "executor", status: "blocked", requestCount: modelRequestCount, result: reason });
        return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return blockedResult(scenario, issue, "Scenario time limit reached before the next Gemini decision.", actionCount, recoveryCount, evidence);
      modelRequestCount += 1;
      trace.modelRequestCount = modelRequestCount;
      const proposed = await agent.generateJson(executorPrompt({
        issue,
        scenario,
        snapshot: latestSnapshot,
        history,
        uniqueTaskText,
        availableTools: tools.map(({ name, inputSchema }) => ({
          name,
          inputSchema: compactSchema(inputSchema) as DiscoveredTool["inputSchema"],
        })),
        invalidActionFeedback,
      }), executorDecisionJsonSchema(tools, rejectedToolName), Math.min(limits.requestTimeoutMs ?? 30_000, remainingMs), "executor", { runId, scenarioId: scenario.id });
      // A service response can arrive at/after its requested timeout. Never act
      // on it or accept a finish assessment after the scenario deadline.
      if (Date.now() >= deadline) return blockedResult(scenario, issue, "Scenario time limit reached while awaiting the Gemini decision.", actionCount, recoveryCount, evidence);
      const decision = parseDecision(proposed);
      if (decision.kind === "finish") {
        const assessments = new Map(decision.assessments.map((assessment) => [assessment.acceptanceCriteriaId, assessment]));
        const unknown = decision.assessments.find((assessment) => !scenario.acceptanceCriteriaIds.includes(assessment.acceptanceCriteriaId));
        if (unknown) throw new Error(`Gemini assessed unrelated criterion ${unknown.acceptanceCriteriaId}.`);
        const missing = scenario.acceptanceCriteriaIds.filter((id) => !assessments.has(id));
        if (missing.length > 0) return blockedResult(scenario, issue, `Final evidence omitted criteria: ${missing.join(", ")}.`, actionCount, recoveryCount, evidence);
        const unproven = decision.assessments.find((assessment) =>
          !observations.some((observation) => observation.stage === "post_action" && observation.text.includes(assessment.observedEvidence)));
        if (unproven) return blockedResult(scenario, issue, `The claimed evidence for ${unproven.acceptanceCriteriaId} does not exactly match any post-action browser snapshot.`, actionCount, recoveryCount, evidence);
        const checks = verifyScenarioChecks(scenario, issue, uniqueTaskText, observations);
        trace.hostVerification = checks;
        const failedCheck = checks.find((check) => check.status === "FAIL");
        const blockedCheck = checks.find((check) => check.status === "BLOCKED");
        const status = failedCheck ? "FAIL"
          : blockedCheck || decision.assessments.some((assessment) => !assessment.meets) ? "BLOCKED" : "PASS";
        const reason = failedCheck
          ? `${failedCheck.acceptanceCriterionId} contradicted by host-verified browser state: ${failedCheck.reason}`
          : blockedCheck
            ? `${blockedCheck.acceptanceCriterionId} could not be verified: ${blockedCheck.reason}`
            : decision.assessments.some((assessment) => !assessment.meets)
              ? "Gemini proposed a failed assessment, but the host verifier found no independently confirmed contradiction."
              : "All scenario verification checks passed against real post-action accessibility snapshots.";
        if (status === "PASS") await screenshot();
        const result: ScenarioResult = {
          scenarioId: scenario.id,
          title: scenario.title,
          acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
          status,
          ...(failedCheck ? { hostVerifiedFailure: true } : {}),
          expected: scenario.expectedResult,
          observed: checks.map((check) => `${check.acceptanceCriterionId} ${check.status}: ${check.reason}; evidence=${check.evidence.join(" | ")}`).join("\n"),
          reason,
          evidence,
          actionCount,
          recoveryCount,
          ...scenarioPlanFields(scenario),
        };
        await record({ toolName: "assertion", status, requestCount: modelRequestCount, modelAssessments: decision.assessments, hostVerification: checks, rationale: decision.rationale });
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
        const refreshed = await captureSnapshot(browser, issue, deadline);
        if (refreshed.isError || !refreshed.text.trim()) return blockedResult(scenario, issue, `Recovery snapshot failed: ${refreshed.text}`, actionCount, recoveryCount, evidence);
        latestSnapshot = refreshed.text;
        verifySnapshotOrigin(latestSnapshot, issue.targetUrl);
        history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
        observations.push({ text: latestSnapshot, stage: "post_action" });
        await record({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 1500), rationale: "Refresh browser state after rejecting a stale reference." });
        await screenshot();
        continue;
      }
      const actionKey = `${decision.toolName}:${JSON.stringify(args)}:${latestSnapshot}`;
      if (actionKey === previousActionKey) unchangedActionCount += 1;
      else unchangedActionCount = 0;
      if (unchangedActionCount >= 1) return blockedResult(scenario, issue, "Repeated identical action against an unchanged snapshot; stopped to prevent an interaction loop.", actionCount, recoveryCount, evidence);
      previousActionKey = actionKey;

      if (Date.now() >= deadline) return blockedResult(scenario, issue, "Scenario time limit reached before the next browser action.", actionCount, recoveryCount, evidence);

      const preActionSnapshot = latestSnapshot;
      await record({
        toolName: decision.toolName,
        event: "pre_action_observation",
        observation: preActionSnapshot.slice(0, 1500),
        arguments: args,
        rationale: decision.rationale,
      });
      if (Date.now() >= deadline) return blockedResult(scenario, issue, "Scenario time limit reached before the next browser action.", actionCount, recoveryCount, evidence);
      actionCount += 1;
      const toolResult = await browser.call(decision.toolName, args, Math.min(20_000, Math.max(1, deadline - Date.now())));
      const actionEvidence: ScenarioBrowserAction = {
        toolName: decision.toolName,
        arguments: args,
        rationale: decision.rationale,
        status: toolResult.isError ? "error" : "ok",
        result: textFromTool(toolResult).slice(0, 2000),
        preActionObservation: preActionSnapshot.slice(0, 4000),
      };
      trace.browserActions.push(actionEvidence);
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
        const refreshed = await captureSnapshot(browser, issue, deadline);
        if (refreshed.isError || !refreshed.text.trim()) return blockedResult(scenario, issue, `Recovery snapshot failed: ${refreshed.text}`, actionCount, recoveryCount, evidence);
        latestSnapshot = refreshed.text;
        verifySnapshotOrigin(latestSnapshot, issue.targetUrl);
        history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
        observations.push({ text: latestSnapshot, stage: "post_action" });
        await record({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 1500), rationale: "Observe browser state after a failed interaction." });
        await screenshot();
        continue;
      }
      history.push({ toolName: decision.toolName, result: textFromTool(toolResult).slice(0, 4000) });
      const observation = await captureSnapshot(browser, issue, deadline);
      if (observation.isError || !observation.text.trim()) return blockedResult(scenario, issue, `Post-action observation failed: ${observation.text}`, actionCount, recoveryCount, evidence);
      latestSnapshot = observation.text;
      verifySnapshotOrigin(latestSnapshot, issue.targetUrl);
      history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
      observations.push({ text: latestSnapshot, stage: "post_action" });
      actionEvidence.postActionObservation = latestSnapshot.slice(0, 4000);
      await record({
        toolName: "browser_snapshot",
        event: "post_action_observation",
        preActionSnapshot: preActionSnapshot.slice(0, 1000),
        result: latestSnapshot.slice(0, 1500),
        rationale: `Observe result after ${decision.toolName}.`,
      });
      await screenshot();
      if (Date.now() >= deadline) return blockedResult(scenario, issue, "Scenario time limit reached before all criteria were verified.", actionCount, recoveryCount, evidence);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const serviceFailure = isGeminiServiceError(error);
      await record({ toolName: "executor", status: serviceFailure ? "service_error" : "error", requestCount: modelRequestCount, result: reason });
      return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
    }
  }
  const reason = Date.now() >= deadline ? "Scenario time limit reached." : "Maximum browser action budget exhausted.";
  await record({ toolName: "executor", status: "blocked", result: reason });
  return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
}

export async function executeScenario(input: ExecuteInput): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const trace: ExecutorTrace = { modelRequestCount: 0, browserActions: [], hostVerification: [] };
  const result = await executeScenarioInternal(input, trace);
  return {
    ...result,
    browserActions: trace.browserActions,
    hostVerification: trace.hostVerification,
    modelRequestCount: trace.modelRequestCount,
    executionDurationMs: Date.now() - startedAt,
  };
}
