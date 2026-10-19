import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  executorDecisionSchema,
  type ExecutorDecision,
  type NormalizedIssue,
  type PlannedScenario,
  type ScenarioBrowserAction,
  type ScenarioResult,
  type ScenarioVerification,
  type ScenarioModelAssessment,
} from "../schemas.js";
import { executorPrompt } from "../prompts/executor-prompt.js";
import { getPermittedTools, validateToolAction, type DiscoveredTool } from "../browser/tool-policy.js";
import { appendActionLog } from "../evidence/logger.js";
import { GeminiRequestError, isGeminiServiceError, getGeminiApiStatusCode } from "./gemini-errors.js";
import { BrowserToolError, DEFAULT_NAVIGATION_TIMEOUT_MS } from "../browser/browser-errors.js";
import { compactToolSchema, executorDecisionJsonSchema } from "./executor-contract.js";
import { InvalidGeminiJsonError, summarizeJsonResponse } from "./response-diagnostics.js";

export { executorDecisionJsonSchema } from "./executor-contract.js";

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
  navigationTimeoutMs?: number;
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
  stage: "initial" | "post_action" | "recovery";
  reference?: string;
  // Set only after an executed, successful, validated model-selected action.
  action?: { toolName: string; arguments: Record<string, unknown> };
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

interface SnapshotListItem {
  matches: boolean;
  checkboxes: string[];
  controls: Array<{ role: string; name: string; reference?: string; active: boolean }>;
}

function snapshotValue(value: string): string {
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === "string" ? parsed : value; } catch { return value; }
}

function matchingListItems(snapshot: string, subject: string, exact = false): SnapshotListItem[] {
  const items: SnapshotListItem[] = [];
  const ancestors: Array<{ indent: number; role: string; item?: typeof items[number] }> = [];
  for (const line of snapshot.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const node = line.match(/^([ \t]*)-\s+([a-z][\w-]*)\b/i)
      // Also support compact snapshots whose children omit the dash.
      ?? line.match(/^([ \t]+)(text|checkbox)\b/i);
    const indent = (node?.[1] ?? line.match(/^[ \t]*/)?.[0] ?? "").length;
    // A sibling or dedented line closes the previous branch. This also clears
    // tree ancestry at Markdown fences, headings, and surrounding tool output.
    while (ancestors.length && ancestors[ancestors.length - 1]!.indent >= indent) ancestors.pop();
    if (!node) continue;
    const role = node[2]!.toLowerCase();
    const rest = line.slice(node[0].length);
    const label = rest.match(/^\s*("(?:\\.|[^"\\])*")/);
    const name = label ? snapshotValue(label[1]!) : "";
    const afterLabel = rest.slice(label?.[0].length ?? 0);
    const attributes = afterLabel.match(/^(?:\s*\[[^\]]*\])*/)?.[0] ?? "";
    const content = afterLabel.match(/^(?:\s*\[[^\]]*\])*\s*:\s*(.*?)\s*$/)?.[1];
    const item: SnapshotListItem | undefined = role === "listitem" ? { matches: false, checkboxes: [], controls: [] }
      : ancestors.at(-1)?.item;
    if (role === "listitem") items.push(item!);
    if (item) {
      if (exact ? name === subject || (content !== undefined && snapshotValue(content) === subject) : line.includes(subject)) item.matches = true;
      if (role === "checkbox") item.checkboxes.push(line);
      item.controls.push({ role, name, reference: attributes.match(/\[ref=(e\d+)\]/)?.[1], active: /\[active\]/.test(attributes) });
    }
    ancestors.push({ indent, role, item });
  }
  return items.filter(({ matches }) => matches);
}

function isVisibleListItem(snapshot: string, subject: string): boolean {
  return matchingListItems(snapshot, subject).length > 0;
}

function checkStateForItem(snapshot: string, subject: string, allowImplicitUnchecked = false): "checked" | "unchecked" | "unknown" {
  const items = matchingListItems(snapshot, subject);
  // A neighboring item's checkbox or an ambiguous duplicate cannot establish
  // this subject's state. Only its own semantic listitem subtree is eligible.
  if (items.length !== 1 || items[0]!.checkboxes.length !== 1) return "unknown";
  const checkbox = items[0]!.checkboxes[0]!.replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/\[checked(?:=true)?\]/i.test(checkbox)) return "checked";
  if (/\[(?:unchecked|checked=false)\]/i.test(checkbox)) return "unchecked";
  if (/\[checked=/i.test(checkbox)) return "unknown";
  // Playwright's full ARIA snapshots omit the state tag for unchecked boxes.
  // For filter setup, the actual checkbox node (not a text label) is required.
  return allowImplicitUnchecked ? "unchecked" : "unknown";
}

function hasActiveFilter(snapshot: string): boolean {
  if (/^[ \t]*(?:-\s+)?(?:link|tab|button)\s+"Active"(?=[^\r\n]*(?:\[current(?:=(?:true|page|step|location|date|time))?\]|\[selected(?:=true)?\]|\[checked\]))/im.test(snapshot)) return true;
  // TodoMVC does not expose aria-current. Corroborate the current URL with the
  // actual observed Active link target; item states are still verified below.
  const pageUrl = snapshot.match(/^\s*-\s*Page URL:\s*(\S+)\s*$/m)?.[1];
  const activeLink = snapshot.match(/^[ \t]*-\s+link\s+"Active"[^\r\n]*\r?\n[ \t]+-\s+\/url:\s*([^\r\n]+)/m)?.[1]?.trim().replace(/^"|"$/g, "");
  if (!pageUrl || !activeLink) return false;
  try { return new URL(activeLink, pageUrl).href === new URL(pageUrl).href; } catch { return false; }
}

function isUnfilteredSnapshot(snapshot: string): boolean {
  if (hasActiveFilter(snapshot)) return false;
  const pageUrl = snapshot.match(/^\s*-\s*Page URL:\s*(\S+)\s*$/m)?.[1];
  if (!pageUrl) return false;
  try {
    return ["", "#", "#/"].includes(new URL(pageUrl).hash);
  } catch { return false; }
}

function filterReadinessFeedback(
  check: PlannedScenario["verificationChecks"][number],
  uniqueTaskText: string,
  snapshots: ObservationSnapshot[],
): string[] {
  const subjects = [...check.expectedVisible, ...check.expectedAbsent];
  if (!check.expectedVisible.length || !check.expectedAbsent.length
    || subjects.some((subject) => !subject.includes("{{uniqueTaskText}}"))
    || subjects.some((subject, index) => subjects.some((other, otherIndex) => index !== otherIndex && other.includes(subject)))) {
    return ["Filter requirements need distinct, non-overlapping included and excluded current-scenario identities using {{uniqueTaskText}}."];
  }
  const included = check.expectedVisible.map((value) => expandUniqueTaskText(value, uniqueTaskText));
  const excluded = check.expectedAbsent.map((value) => expandUniqueTaskText(value, uniqueTaskText));
  // Final filtering must follow the latest proven setup state directly. An
  // older setup cannot conceal later deletion or completion-state changes.
  const final = snapshots.at(-1);
  const setupIndex = final && hasActiveFilter(final.text) ? snapshots.length - 2 : snapshots.length - 1;
  const setup = snapshots[setupIndex];
  const prior = setup?.stage === "post_action" && isUnfilteredSnapshot(setup.text) ? [{ ...setup, index: setupIndex }] : [];
  const freshlyObserved = (subject: string, index: number) => snapshots.slice(0, index).some(({ stage, text }) =>
    stage !== "recovery" && isUnfilteredSnapshot(text) && !isVisibleListItem(text, subject));
  const observesState = (observation: typeof prior[number], subject: string, state: "checked" | "unchecked") =>
    freshlyObserved(subject, observation.index) && checkStateForItem(observation.text, subject, true) === state;
  const setupObserved = prior.some((observation) => included.every((subject) => observesState(observation, subject, "unchecked"))
    && excluded.every((subject) => observesState(observation, subject, "checked")));
  const feedback: string[] = [];
  if (!setupObserved) {
    for (const [values, state, description] of [[included, "unchecked", "included"], [excluded, "checked", "excluded"]] as const) {
      for (const subject of values) {
        if (!prior.some((observation) => observesState(observation, subject, state))) {
          feedback.push(`Missing pre-filter observation of ${description} item "${subject}" with its own ${state} checkbox. It must be observed before the final filter result, after being absent earlier in this scenario; initial or recovery snapshots and older tasks do not establish setup.`);
        }
      }
    }
    feedback.push("Observe all included unchecked items and excluded checked items together in a successful unfiltered post-action snapshot immediately before the final filter selection. If already filtered, inspect the current controls and restore a view that exposes the missing setup, then complete it autonomously.");
  }
  if (snapshots.at(-1)?.stage !== "post_action") feedback.push("A successful action and fresh post-action snapshot are required before final filter verification.");
  else if (!hasActiveFilter(snapshots.at(-1)!.text)) feedback.push("The final accessibility snapshot must establish that the observed Active filter is selected after setup.");
  return feedback;
}

function isRemovalAction(snapshot: string, subject: string, action: NonNullable<ObservationSnapshot["action"]>): boolean {
  const items = matchingListItems(snapshot, subject, true);
  if (items.length !== 1) return false;
  const reference = action.arguments.target ?? action.arguments.ref;
  const removalControls = items[0]!.controls.filter(({ role, name }) =>
    ["button", "link", "menuitem"].includes(role) && /\b(?:delete|remove|trash|discard)\b/i.test(name));
  if (action.toolName === "browser_click") return removalControls.some((control) => control.reference === reference);
  // Keyboard activation is supported only for an actually focused removal
  // control, never from a rationale or a Delete key sent to a textbox.
  return action.toolName === "browser_press_key" && ["Enter", "Space"].includes(String(action.arguments.key))
    && removalControls.some(({ active }) => active);
}

function verifyDeletionCheck(
  check: PlannedScenario["verificationChecks"][number], uniqueTaskText: string,
  snapshots: ObservationSnapshot[], evidence: string[],
): VerificationCheckResult {
  const result = (status: VerificationCheckResult["status"], reason: string): VerificationCheckResult =>
    ({ acceptanceCriterionId: check.acceptanceCriterionId, status, reason, evidence });
  if (check.expectedVisible.length !== 1 || check.expectedAbsent.length !== 1
    || check.expectedVisible[0] !== check.expectedAbsent[0] || !check.expectedVisible[0]!.includes("{{uniqueTaskText}}")) {
    return result("BLOCKED", "Removal verification requires the same exact current-scenario task marker in expectedVisible and expectedAbsent.");
  }
  const subject = expandUniqueTaskText(check.expectedVisible[0]!, uniqueTaskText);
  const eligible = (observation: ObservationSnapshot) => observation.stage !== "recovery" && isUnfilteredSnapshot(observation.text);
  const seen = snapshots.findIndex((observation, index) => observation.stage === "post_action" && eligible(observation)
    && matchingListItems(observation.text, subject, true).length === 1
    && snapshots.slice(0, index).some((earlier) => eligible(earlier) && !matchingListItems(earlier.text, subject, true).length));
  if (seen < 0) return result("BLOCKED", `Cannot verify removal because the exact current-scenario task "${subject}" was never observed as a newly visible list item before deletion. Create and observe it in an unfiltered post-action snapshot; unrelated or initial tasks are insufficient.`);
  const attempted = snapshots.map((observation, index) => ({ observation, index })).filter(({ observation, index }) =>
    index > seen && observation.stage === "post_action" && observation.action
    && snapshots[index - 1]!.stage !== "recovery" && eligible(snapshots[index - 1]!)
    && isRemovalAction(snapshots[index - 1]!.text, subject, observation.action)).at(-1)?.index ?? -1;
  if (attempted < 0) return result("BLOCKED", `No observed removal control associated with the exact task "${subject}" has been activated. Inspect its current controls and attempt removal; snapshots, hover, navigation, or deleting another task do not establish this evidence.`);
  const final = snapshots.at(-1)!;
  if (final.stage !== "post_action" || !isUnfilteredSnapshot(final.text)) {
    return result("BLOCKED", "Removal verification needs a later authentic unfiltered post-action observation; a filtered view or recovery snapshot cannot prove deletion.");
  }
  const pageUrl = (text: string) => text.match(/^\s*-\s*Page URL:\s*(\S+)\s*$/m)?.[1];
  if (pageUrl(final.text) !== pageUrl(snapshots[attempted - 1]!.text)
    || snapshots.slice(attempted + 1).some(({ stage, action }) => stage !== "post_action" || action?.toolName !== "browser_snapshot")) {
    return result("BLOCKED", "The removal observation was superseded by navigation, another interaction, or recovery. Observe the exact target and its removal result in the same unfiltered view; only subsequent read-only snapshots can extend that proof.");
  }
  if (matchingListItems(final.text, subject, true).length) return result("FAIL", `The exact task "${subject}" is still visible after its observed removal control was activated.`);
  return result("PASS", "The exact current-scenario task was observed as a list item, its removal control was activated, and the task is absent in the later unfiltered post-action snapshot.");
}

export function verifyScenarioChecks(
  scenario: PlannedScenario,
  issue: NormalizedIssue,
  uniqueTaskText: string,
  snapshots: ObservationSnapshot[],
): VerificationCheckResult[] {
  // A newer recovery observation must not leave an older successful state
  // eligible for final verification.
  const finalObservation = snapshots.at(-1);
  const finalSnapshot = finalObservation?.stage === "post_action" ? finalObservation.text : "";
  return scenario.verificationChecks.map((check) => {
    if (!scenario.acceptanceCriteriaIds.includes(check.acceptanceCriterionId)
      || !issue.acceptanceCriteria.some(({ id }) => id === check.acceptanceCriterionId)) {
      return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: "Verification check references an unknown acceptance criterion.", evidence: [] };
    }
    const expectedVisible = check.expectedVisible.map((value) => expandUniqueTaskText(value, uniqueTaskText));
    const expectedAbsent = check.expectedAbsent.map((value) => expandUniqueTaskText(value, uniqueTaskText));
    const evidence = !finalSnapshot ? []
      : check.kind === "filter" || check.kind === "absent_after_seen"
        ? snapshots.flatMap(({ reference }) => reference ? [reference] : [])
        : finalObservation?.reference ? [finalObservation.reference] : [];
    if (check.kind === "absent_after_seen") return verifyDeletionCheck(check, uniqueTaskText, snapshots, evidence);
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
    if (check.kind === "checked") {
      const subject = expectedVisible[0]!;
      if (!isVisibleListItem(finalSnapshot, subject)) return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: `Cannot verify completion because "${subject}" is not visible as a semantic list item in the final observation.`, evidence };
      const state = checkStateForItem(finalSnapshot, subject);
      if (state === "checked") return { acceptanceCriterionId: check.acceptanceCriterionId, status: "PASS", reason: "The subject is visible with a checked checkbox state in the final accessibility snapshot.", evidence };
      if (state === "unchecked") return { acceptanceCriterionId: check.acceptanceCriterionId, status: "FAIL", reason: `The subject "${subject}" is explicitly observed with an unchecked checkbox.`, evidence };
      return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: `No reliable checked/unchecked checkbox state was observed for "${subject}".`, evidence };
    }
    const missingReadiness = filterReadinessFeedback(check, uniqueTaskText, snapshots);
    if (missingReadiness.length) return { acceptanceCriterionId: check.acceptanceCriterionId, status: "BLOCKED", reason: missingReadiness.join(" "), evidence };
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

class InvalidExecutorDecisionError extends Error {}

const decisionFields = new Set([
  "kind", "toolName", "arguments", "rationale", "assessments",
  "acceptanceCriteriaId", "meets", "observedEvidence", "explanation",
]);

function parseDecision(value: unknown): ExecutorDecision {
  const parsed = executorDecisionSchema.safeParse(value);
  if (!parsed.success) {
    // Zod messages can include rejected values/keys. Feedback names only known
    // contract fields and fixed requirements, never arbitrary model content.
    const feedback = parsed.error.issues.slice(0, 8).map((issue) => {
      const path = issue.path.map((part) => typeof part === "number" ? String(part)
        : typeof part === "string" && decisionFields.has(part) ? part : "[unknown]").join(".") || "decision";
      return `${path}: ${path === "kind" ? 'must be "action" or "finish"' : "missing or invalid required value"}`;
    }).join("; ");
    throw new InvalidExecutorDecisionError(`Gemini executor response failed validation: ${feedback}`);
  }
  return parsed.data;
}

function toolValidationFeedback(decision: Extract<ExecutorDecision, { kind: "action" }>, tools: DiscoveredTool[]): string {
  const tool = tools.find(({ name }) => name === decision.toolName);
  if (!tool) return "The tool name is not permitted; select an exact toolName from the supplied MCP contracts.";
  const missing = (tool.inputSchema.required ?? []).filter((key) => !Object.hasOwn(decision.arguments, key));
  if (missing.length) return `Missing required arguments for ${tool.name}: ${missing.join(", ")}.`;
  return `Arguments for ${tool.name} must match its exact MCP contract, use current accessibility references, and remain within the allowed origin. Undeclared fields and unsafe values are rejected.`;
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
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Scenario time limit reached before browser snapshot capture.");
  const args = validateToolAction("browser_snapshot", {}, browser.discoveredTools, issue.targetUrl);
  return browser.call("browser_snapshot", args, Math.min(20_000, remainingMs));
}

interface ExecutorTrace {
  modelRequestCount: number;
  browserActions: ScenarioBrowserAction[];
  hostVerification: ScenarioVerification[];
  modelAssessments?: ScenarioModelAssessment[];
  modelAssessmentWarnings?: string[];
  infrastructureError?: ScenarioResult["infrastructureError"];
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
  let snapshotCount = 0;
  let recoveryCount = 0;
  let invalidDecisionRecoveryCount = 0;
  let latestSnapshot = "";
  let invalidActionFeedback: string | undefined;
  let rejectedToolName: string | undefined;
  let previousActionKey = "";
  let unchangedActionCount = 0;
  let snapshotLoopCorrectionCount = 0;
  let snapshotActionFeedback: string | undefined;
  const tools = getPermittedTools(browser.discoveredTools);
  const uniqueTaskText = `QA-${runId}-${scenario.id}`;
  const maxModelRequests = limits.maxModelRequests ?? limits.maxActions + limits.maxRecoveryRetries + 1;
  const retainObservation = async (text: string, stage: ObservationSnapshot["stage"], action?: ObservationSnapshot["action"]) => {
    verifySnapshotOrigin(text, issue.targetUrl);
    snapshotCount += 1;
    const safeScenarioId = scenario.id.replace(/[^A-Za-z0-9_-]/g, "_");
    const reference = resolve(screenshotDirectory, `${safeScenarioId}-snapshot-${String(snapshotCount).padStart(2, "0")}.txt`);
    await writeFile(reference, text, "utf8");
    const observation = { text, stage, reference, ...(action ? { action } : {}) };
    observations.push(observation);
    return observation;
  };
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
    const remainingNavigationMs = deadline - Date.now();
    if (remainingNavigationMs <= 0) throw new Error("Scenario time limit reached before initial browser navigation.");
    const navigation = await browser.call("browser_navigate", navigationArgs, Math.min(limits.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS, remainingNavigationMs));
    if (navigation.isError) throw new Error(`Navigation failed: ${navigation.text}`);
    if (Date.now() >= deadline) throw new Error("Scenario time limit reached during initial browser navigation.");
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
    const initialObservation = await retainObservation(latestSnapshot, "initial");
    history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
    await record({ toolName: "browser_snapshot", snapshotReference: initialObservation.reference, result: latestSnapshot.slice(0, 1500), rationale: "Observe accessible page state before acting." });
    await screenshot();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    trace.infrastructureError = { source: "browser", serviceFailure: false, operation: error instanceof BrowserToolError ? error.operation : "browser_initialization" };
    await record({ toolName: "browser_initialization", status: "error", result: reason });
    return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
  }

  while (Date.now() < deadline) {
    try {
      const deletionChecks = verifyScenarioChecks(scenario, issue, uniqueTaskText, observations)
        .filter((check) => scenario.verificationChecks.some((planned) => planned.kind === "absent_after_seen" && planned.acceptanceCriterionId === check.acceptanceCriterionId));
      const finishReadinessFeedback = scenario.verificationChecks.filter(({ kind }) => kind === "filter")
        .flatMap((check) => filterReadinessFeedback(check, uniqueTaskText, observations).map((message) => `${check.acceptanceCriterionId}: ${message}`))
        .concat(deletionChecks.filter(({ status }) => status === "BLOCKED").map((check) => `${check.acceptanceCriterionId}: ${check.reason}`));
      const hostVerificationFeedback = deletionChecks.map((check) => `${check.acceptanceCriterionId}: ${check.status === "BLOCKED" ? "Missing evidence" : `Ready for finish; host check ${check.status}`} — ${check.reason} Snapshot references: ${check.evidence.join(" | ") || "none"}.`);
      if (modelRequestCount >= maxModelRequests) {
        const reason = `Maximum Gemini executor request budget exhausted (${maxModelRequests}).${finishReadinessFeedback.length ? ` Incomplete verification setup: ${finishReadinessFeedback.join(" ")}` : ""}`;
        await record({ toolName: "executor", status: "blocked", requestCount: modelRequestCount, result: reason });
        return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return blockedResult(scenario, issue, "Scenario time limit reached before the next Gemini decision.", actionCount, recoveryCount, evidence);
      modelRequestCount += 1;
      trace.modelRequestCount = modelRequestCount;
      let proposed: unknown;
      let decision: ExecutorDecision;
      try {
        proposed = await agent.generateJson(executorPrompt({
          issue,
          scenario,
          snapshot: latestSnapshot,
          history,
          uniqueTaskText,
          availableTools: tools.map(({ name, inputSchema }) => ({
            name,
            inputSchema: compactToolSchema(inputSchema) as DiscoveredTool["inputSchema"],
          })),
          invalidActionFeedback,
          finishReadinessFeedback,
          hostVerificationFeedback,
          snapshotActionFeedback,
        }), executorDecisionJsonSchema(tools, rejectedToolName), Math.min(limits.requestTimeoutMs ?? 30_000, remainingMs), "executor", { runId, scenarioId: scenario.id }).catch((error: unknown) => {
          if (error instanceof InvalidGeminiJsonError || error instanceof GeminiRequestError) throw error;
          throw new GeminiRequestError(error);
        });
        // A service response can arrive at/after its requested timeout. Never act
        // on it or accept a finish assessment after the scenario deadline.
        if (Date.now() >= deadline) return blockedResult(scenario, issue, "Scenario time limit reached while awaiting the Gemini decision.", actionCount, recoveryCount, evidence);
        decision = parseDecision(proposed);
      } catch (error) {
        if (!(error instanceof InvalidExecutorDecisionError) && !(error instanceof InvalidGeminiJsonError)) throw error;
        const reason = error instanceof InvalidExecutorDecisionError ? error.message
          : `Gemini executor response failed validation: ${error.message}`;
        await record({
          toolName: "executor", event: "executor_response_invalid", status: "invalid_response",
          ...summarizeJsonResponse(proposed),
          ...(error instanceof InvalidGeminiJsonError ? { responseType: "unparseable", responseDiscriminator: "unavailable" } : {}),
          validationFeedback: reason, invalidDecisionRecoveryCount,
        });
        if (Date.now() >= deadline) return blockedResult(scenario, issue, "Scenario time limit reached while awaiting the Gemini decision.", actionCount, recoveryCount, evidence);
        if (invalidDecisionRecoveryCount >= 1 || recoveryCount >= limits.maxRecoveryRetries) {
          return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
        }
        invalidDecisionRecoveryCount += 1;
        recoveryCount += 1;
        invalidActionFeedback = reason;
        rejectedToolName = undefined;
        continue;
      }
      if (decision.kind === "finish") {
        const checks = verifyScenarioChecks(scenario, issue, uniqueTaskText, observations);
        for (const criterionId of scenario.acceptanceCriteriaIds) {
          if (!checks.some((check) => check.acceptanceCriterionId === criterionId)) {
            checks.push({ acceptanceCriterionId: criterionId, status: "BLOCKED", reason: "No independent host verification check covers this criterion.", evidence: [] });
          }
        }
        if (checks.length === 0) checks.push({ acceptanceCriterionId: "UNSPECIFIED", status: "BLOCKED", reason: "No independent host verification checks were provided.", evidence: [] });

        const finalObservation = observations.at(-1);
        let evidenceProblem: string | undefined;
        if (finalObservation?.stage === "post_action") {
          if (!trace.browserActions.slice(1).some((action) => action.status === "ok")) {
            evidenceProblem = "No successful model-selected browser action supports the final observation.";
          } else if (!finalObservation.reference || evidence.length < 2) {
            evidenceProblem = "The final observation lacks retained snapshot or screenshot evidence.";
          } else {
            try {
              // Only host-captured, origin-checked text and retained screenshot
              // files can support PASS; model claims never become artifact paths.
              verifySnapshotOrigin(finalObservation.text, issue.targetUrl);
              await Promise.all(observations.map(async (observation) => {
                if (!observation.reference || await readFile(observation.reference, "utf8") !== observation.text) throw new Error("Snapshot artifact does not match the captured observation.");
              }));
              await Promise.all(evidence.map((path) => access(path)));
            } catch {
              evidenceProblem = "Retained snapshot or screenshot evidence is unavailable or does not match the captured observation.";
            }
          }
        }
        if (evidenceProblem) {
          for (const check of checks) Object.assign(check, { status: "BLOCKED", reason: evidenceProblem, evidence: [] });
        }
        trace.hostVerification = checks;

        const modelAssessmentWarnings: string[] = [];
        const seenModelCriteria = new Set<string>();
        const modelAssessments: ScenarioModelAssessment[] = decision.assessments.map((assessment) => {
          const relevant = scenario.acceptanceCriteriaIds.includes(assessment.acceptanceCriteriaId);
          const matched = relevant ? observations.filter((observation) =>
            observation.stage === "post_action" && observation.reference && observation.text.includes(assessment.observedEvidence)) : [];
          if (!relevant) modelAssessmentWarnings.push("A model assessment references a criterion outside this scenario and does not determine the host result.");
          else {
            if (seenModelCriteria.has(assessment.acceptanceCriteriaId)) modelAssessmentWarnings.push(`Duplicate model assessment for ${assessment.acceptanceCriteriaId}; host checks determine its result.`);
            seenModelCriteria.add(assessment.acceptanceCriteriaId);
            if (!matched.length) modelAssessmentWarnings.push(`The model evidence claim for ${assessment.acceptanceCriteriaId} is unsupported by a literal post-action excerpt; it is advisory and does not determine the host result.`);
            const hostCheck = checks.find((check) => check.acceptanceCriterionId === assessment.acceptanceCriteriaId);
            if (hostCheck && ((hostCheck.status === "PASS" && !assessment.meets) || (hostCheck.status !== "PASS" && assessment.meets))) {
              modelAssessmentWarnings.push(`The model assessment for ${assessment.acceptanceCriteriaId} disagrees with host verification; the host result is authoritative.`);
            }
          }
          return { ...assessment, evidenceStatus: matched.length ? "MATCHED_POST_ACTION" : "UNSUPPORTED", snapshotReferences: matched.flatMap(({ reference }) => reference ? [reference] : []) };
        });
        for (const criterionId of scenario.acceptanceCriteriaIds) {
          if (!seenModelCriteria.has(criterionId)) modelAssessmentWarnings.push(`The model omitted an assessment for ${criterionId}; host verification determines its result.`);
        }
        trace.modelAssessments = modelAssessments;
        trace.modelAssessmentWarnings = modelAssessmentWarnings;
        if (finishReadinessFeedback.length && !evidenceProblem && !checks.some(({ status }) => status === "FAIL")) {
          // A finish proposal is not permission to skip generated verification
          // prerequisites. Continue normal model/tool selection with concrete
          // host feedback; every proposal still spends the existing request
          // budget and all actions/deadlines retain their original limits.
          await record({ toolName: "executor", event: "finish_deferred", status: "not_ready", requestCount: modelRequestCount,
            finishReadinessFeedback, hostVerification: checks, modelAssessments, modelAssessmentWarnings,
            snapshotReferences: observations.flatMap(({ reference }) => reference ? [reference] : []) });
          if (actionCount >= limits.maxActions) return blockedResult(scenario, issue,
            `Maximum model-selected browser action budget exhausted before verification readiness. ${finishReadinessFeedback.join(" ")}`, actionCount, recoveryCount, evidence);
          continue;
        }
        const failedCheck = checks.find((check) => check.status === "FAIL");
        const blockedCheck = checks.find((check) => check.status === "BLOCKED");
        const status = failedCheck ? "FAIL" : blockedCheck ? "BLOCKED" : "PASS";
        const reason = failedCheck
          ? `${failedCheck.acceptanceCriterionId} contradicted by host-verified browser state: ${failedCheck.reason}`
          : blockedCheck
            ? `${blockedCheck.acceptanceCriterionId} could not be verified: ${blockedCheck.reason}`
            : "All scenario verification checks passed against real post-action accessibility snapshots.";
        if (status === "PASS") {
          try {
            await screenshot();
          } catch (error) {
            for (const check of checks) Object.assign(check, { status: "BLOCKED", reason: "The final screenshot could not be retained; the scenario evidence is incomplete." });
            throw error;
          }
        }
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
        await record({ toolName: "assertion", status, requestCount: modelRequestCount, modelAssessments, modelAssessmentWarnings, hostVerification: checks, rationale: decision.rationale });
        return result;
      }

      let args: Record<string, unknown>;
      try {
        args = validateToolAction(decision.toolName, decision.arguments, browser.discoveredTools, issue.targetUrl);
      } catch {
        const reason = toolValidationFeedback(decision, tools);
        await record({
          toolName: tools.some(({ name }) => name === decision.toolName) ? decision.toolName : "unpermitted_tool",
          event: "executor_response_invalid", status: "rejected", ...summarizeJsonResponse(decision),
          validationFeedback: reason, invalidDecisionRecoveryCount,
        });
        if (invalidDecisionRecoveryCount >= 1 || recoveryCount >= limits.maxRecoveryRetries) return blockedResult(scenario, issue, reason, actionCount, recoveryCount, evidence);
        invalidDecisionRecoveryCount += 1;
        recoveryCount += 1;
        invalidActionFeedback = reason;
        rejectedToolName = tools.some(({ name }) => name === decision.toolName) ? decision.toolName : undefined;
        continue;
      }
      invalidActionFeedback = undefined;
      rejectedToolName = undefined;
      const targetReference = typeof args.target === "string" ? args.target : typeof args.ref === "string" ? args.ref : undefined;
      if (targetReference && !latestSnapshot.includes(`[ref=${targetReference}]`)) {
        const message = `Element reference ${targetReference} is not present in the latest accessibility snapshot.`;
        await record({
          toolName: decision.toolName, event: "executor_response_invalid", status: "stale_reference",
          ...summarizeJsonResponse(decision), validationFeedback: message, invalidDecisionRecoveryCount,
        });
        if (invalidDecisionRecoveryCount >= 1 || recoveryCount >= limits.maxRecoveryRetries) return blockedResult(scenario, issue, `${message} Recovery limit reached.`, actionCount, recoveryCount, evidence);
        invalidDecisionRecoveryCount += 1;
        recoveryCount += 1;
        invalidActionFeedback = message;
        const refreshed = await captureSnapshot(browser, issue, deadline);
        if (refreshed.isError || !refreshed.text.trim()) return blockedResult(scenario, issue, `Recovery snapshot failed: ${refreshed.text}`, actionCount, recoveryCount, evidence);
        latestSnapshot = refreshed.text;
        const recoveryObservation = await retainObservation(latestSnapshot, "recovery");
        history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
        await record({ toolName: "browser_snapshot", snapshotReference: recoveryObservation.reference, result: latestSnapshot.slice(0, 1500), rationale: "Refresh browser state after rejecting a stale reference." });
        await screenshot();
        continue;
      }
      const actionKey = `${decision.toolName}:${JSON.stringify(args)}:${latestSnapshot}`;
      if (actionKey === previousActionKey) unchangedActionCount += 1;
      else unchangedActionCount = 0;
      if (unchangedActionCount >= 1) {
        if (decision.toolName === "browser_snapshot" && snapshotLoopCorrectionCount < 1 && recoveryCount < limits.maxRecoveryRetries) {
          snapshotLoopCorrectionCount += 1;
          recoveryCount += 1;
          snapshotActionFeedback = "Duplicate browser_snapshot against unchanged state was not executed. A fresh snapshot is automatically collected after every action. Use the current snapshot and host verification feedback: return a finish decision when evidence is ready, or choose a different safe action to obtain missing evidence. This is the only duplicate-snapshot correction; repeating it will stop the scenario.";
          await record({ toolName: "browser_snapshot", event: "duplicate_snapshot_deferred", status: "not_executed", snapshotLoopCorrectionCount,
            snapshotReference: observations.at(-1)?.reference, hostVerification: deletionChecks, validationFeedback: snapshotActionFeedback });
          continue;
        }
        await record({ toolName: decision.toolName, event: "duplicate_action_blocked", status: "blocked", snapshotLoopCorrectionCount, snapshotReference: observations.at(-1)?.reference });
        return blockedResult(scenario, issue, "Repeated identical action against an unchanged snapshot; stopped to prevent an interaction loop.", actionCount, recoveryCount, evidence);
      }
      previousActionKey = actionKey;
      snapshotActionFeedback = undefined;
      if (actionCount >= limits.maxActions) return blockedResult(scenario, issue, "Maximum model-selected browser action budget exhausted.", actionCount, recoveryCount, evidence);

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
      const toolTimeout = decision.toolName === "browser_navigate" ? limits.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS : 20_000;
      const toolResult = await browser.call(decision.toolName, args, Math.min(toolTimeout, Math.max(1, deadline - Date.now())))
        .catch((error: unknown) => { throw error instanceof BrowserToolError ? error : new BrowserToolError(decision.toolName, error); });
      const actionEvidence: ScenarioBrowserAction = {
        toolName: decision.toolName,
        arguments: args,
        rationale: decision.rationale,
        status: toolResult.isError ? "error" : "ok",
        result: textFromTool(toolResult).slice(0, 2000),
        preActionObservation: preActionSnapshot.slice(0, 4000),
      };
      trace.browserActions.push(actionEvidence);
      for (const check of scenario.verificationChecks.filter(({ kind }) => kind === "absent_after_seen")) {
        const subject = expandUniqueTaskText(check.expectedVisible[0] ?? "", uniqueTaskText);
        if (subject && isRemovalAction(preActionSnapshot, subject, { toolName: decision.toolName, arguments: args })) {
          await record({ toolName: decision.toolName, event: "removal_attempt", status: toolResult.isError ? "error" : "ok",
            acceptanceCriterionId: check.acceptanceCriterionId, subject, arguments: args, sourceSnapshotReference: observations.at(-1)?.reference });
        }
      }
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
        const recoveryObservation = await retainObservation(latestSnapshot, "recovery");
        history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
        await record({ toolName: "browser_snapshot", snapshotReference: recoveryObservation.reference, result: latestSnapshot.slice(0, 1500), rationale: "Observe browser state after a failed interaction." });
        await screenshot();
        continue;
      }
      history.push({ toolName: decision.toolName, result: textFromTool(toolResult).slice(0, 4000) });
      const observation = await captureSnapshot(browser, issue, deadline);
      if (observation.isError || !observation.text.trim()) return blockedResult(scenario, issue, `Post-action observation failed: ${observation.text}`, actionCount, recoveryCount, evidence);
      latestSnapshot = observation.text;
      const postActionObservation = await retainObservation(latestSnapshot, "post_action", { toolName: decision.toolName, arguments: args });
      history.push({ toolName: "browser_snapshot", result: latestSnapshot.slice(0, 4000) });
      actionEvidence.postActionObservation = latestSnapshot.slice(0, 4000);
      await record({
        toolName: "browser_snapshot",
        event: "post_action_observation",
        snapshotReference: postActionObservation.reference,
        preActionSnapshot: preActionSnapshot.slice(0, 1000),
        result: latestSnapshot.slice(0, 1500),
        rationale: `Observe result after ${decision.toolName}.`,
      });
      await screenshot();
      if (scenario.verificationChecks.some(({ kind }) => kind === "absent_after_seen")) {
        const checks = verifyScenarioChecks(scenario, issue, uniqueTaskText, observations);
        await record({ toolName: "executor", event: "verification_readiness", status: checks.every(({ status }) => status !== "BLOCKED") ? "ready_for_finish" : "needs_evidence",
          pendingFinalArtifactValidation: true, hostVerification: checks, snapshotReference: postActionObservation.reference });
      }
      if (Date.now() >= deadline) return blockedResult(scenario, issue, "Scenario time limit reached before all criteria were verified.", actionCount, recoveryCount, evidence);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const source = error instanceof GeminiRequestError ? "gemini" : error instanceof BrowserToolError ? "browser" : "executor";
      const serviceFailure = source === "gemini" && isGeminiServiceError(error);
      const httpStatus = source === "gemini" ? getGeminiApiStatusCode(error) : null;
      trace.infrastructureError = { source, serviceFailure, ...(httpStatus !== null ? { httpStatus } : {}), ...(error instanceof BrowserToolError ? { operation: error.operation } : {}) };
      await record({ toolName: "executor", status: serviceFailure ? "service_error" : "error", errorSource: source, requestCount: modelRequestCount, result: reason });
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
    ...(trace.infrastructureError ? { infrastructureError: trace.infrastructureError } : {}),
    ...(trace.modelAssessments ? { modelAssessments: trace.modelAssessments } : {}),
    ...(trace.modelAssessmentWarnings ? { modelAssessmentWarnings: trace.modelAssessmentWarnings } : {}),
    modelRequestCount: trace.modelRequestCount,
    executionDurationMs: Date.now() - startedAt,
  };
}
