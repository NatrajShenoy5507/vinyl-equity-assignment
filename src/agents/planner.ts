import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { applicationContextSchema, type ApplicationContext } from "../browser/explorer.js";
import { appendActionLog, evidenceDirectory } from "../evidence/logger.js";
import type { NormalizedIssue, ScenarioPlan } from "../schemas.js";
import { scenarioPlanSchema } from "../schemas.js";
import { plannerPrompt } from "../prompts/planner-prompt.js";
import { isGeminiServiceError } from "./gemini-errors.js";

const plannerJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    issueNumber: { type: "integer" },
    scenarios: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          acceptanceCriteriaIds: { type: "array", minItems: 1, maxItems: 1, items: { type: "string" } },
          preconditions: { type: "array", items: { type: "string" } },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: { intent: { type: "string" }, expectedObservation: { type: "string" } },
              required: ["intent", "expectedObservation"],
              additionalProperties: false,
            },
          },
          verificationStrategy: { type: "string" },
          verificationChecks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                acceptanceCriterionId: { type: "string" },
                kind: { type: "string", enum: ["visible", "absent_after_seen", "checked", "filter"] },
                expectedVisible: { type: "array", items: { type: "string" } },
                expectedAbsent: { type: "array", items: { type: "string" } },
              },
              required: ["acceptanceCriterionId", "kind", "expectedVisible", "expectedAbsent"],
              additionalProperties: false,
            },
          },
          relevantApplicationContext: { type: "array", items: { type: "string" } },
          unknownControlsToDiscover: { type: "array", items: { type: "string" } },
          expectedResult: { type: "string" },
        },
        required: [
          "id",
          "title",
          "acceptanceCriteriaIds",
          "preconditions",
          "steps",
          "verificationStrategy",
          "verificationChecks",
          "relevantApplicationContext",
          "unknownControlsToDiscover",
          "expectedResult",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["issueNumber", "scenarios"],
  additionalProperties: false,
};

const cacheSchema = z.object({
  issueFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  applicationContextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  planningContractFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  modelName: z.string().min(1),
  generatedAt: z.string().datetime(),
  plan: z.unknown(),
});

const generationArtifactSchema = z.object({
  runId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  modelName: z.string().min(1),
  planningContractFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  applicationContextReference: z.object({
    path: z.string().min(1),
    runId: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  generatedAt: z.string().datetime(),
  artifactCreatedAt: z.string().datetime(),
  source: z.enum(["gemini", "validated-cache"]),
  cache: z.object({
    status: z.enum(["HIT", "MISS"]),
    invalidationReason: z.string().optional(),
  }),
  scenarios: scenarioPlanSchema.shape.scenarios,
  acceptanceCriteriaMapping: z.record(z.string(), z.array(z.string())),
});

export interface PlannerAgent {
  readonly model: string;
  generateJson(
    prompt: string,
    schema: Record<string, unknown>,
    timeoutMs?: number,
    requestKind?: "planner" | "executor",
  ): Promise<unknown>;
}

export interface ScenarioGenerationArtifact extends z.infer<typeof generationArtifactSchema> {}

export interface ScenarioGenerationOptions {
  cachePath?: string;
  artifactPath?: string;
  applicationContextPath?: string;
  logAction?: (event: Record<string, unknown>) => Promise<void>;
}

export function validateApplicationContext(input: unknown, issue: NormalizedIssue): ApplicationContext {
  const parsed = applicationContextSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Application context is malformed: ${parsed.error.issues.map((entry) => `${entry.path.join(".")}: ${entry.message}`).join("; ")}`);
  }
  const context = parsed.data;
  if (context.status !== "PASS") {
    const reasons = context.diagnostics.map(({ stage, message }) => `${stage}: ${message}`).join("; ");
    throw new Error(`Application context is not successful${reasons ? `: ${reasons}` : "."}`);
  }
  if (context.targetUrl !== issue.targetUrl || context.sourceReferences.targetUrl !== issue.targetUrl) {
    throw new Error("Application context target URL does not match the normalized issue target URL.");
  }
  if (!context.page.title?.trim()) throw new Error("Application context is missing the observed page title.");
  if (!context.page.currentUrl || !context.page.observedAt) throw new Error("Application context is missing the observed current URL or observation timestamp.");
  if (!context.page.accessibilitySnapshot?.trim()) throw new Error("Application context is missing the accessibility snapshot.");
  if (!context.evidence.screenshot) throw new Error("Application context is missing the exploration screenshot reference.");
  const targetOrigin = new URL(issue.targetUrl).origin;
  if (new URL(context.page.currentUrl).origin !== targetOrigin) {
    throw new Error("Application context current URL is outside the normalized issue target origin.");
  }
  return context;
}

function applicationContextInput(context: ApplicationContext): Record<string, unknown> {
  return {
    targetUrl: context.targetUrl,
    title: context.page.title,
    currentUrl: context.page.currentUrl,
    accessibilitySnapshot: context.page.accessibilitySnapshot,
    visibleSemanticControls: context.page.visibleSemanticControls,
    unknowns: context.unknowns,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Bump for host planning-rule changes; prompt and either response schema changes
// are detected automatically, including changes that leave old plans parseable.
const planningContractVersion = 2;

function planningContractFingerprint(issue: NormalizedIssue, applicationContext: ApplicationContext): string {
  return fingerprint({
    version: planningContractVersion,
    prompt: plannerPrompt(issue, applicationContext),
    responseSchema: plannerJsonSchema,
    hostSchema: z.toJSONSchema(scenarioPlanSchema),
  });
}

function hasUnsupportedReferenceOrSelector(plan: ScenarioPlan): boolean {
  const forbiddenPatterns = [
    /\[ref=e\d+\]/i,
    /\b(?:ref|target)\s*[:=]\s*["']?e\d+\b/i,
    /\be\d+\b/i,
    /\b(?:css|xpath)\s*[=:]/i,
    /\bxpath\s*\(/i,
    /document\.querySelector(?:All)?\s*\(/i,
    /\.locator\s*\(|\.getBy(?:Role|Text|Label|Placeholder)\s*\(/i,
    /\[[\w-]+(?:[~|^$*]?=)[^\]]+\]/,
    /(?:^|\s)[a-z][\w-]*(?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:=|\]))/i,
    /(?:^|\s)\/\/(?:[\w*]|\[)/i,
    /(?:^|\s)#[A-Za-z_][\w-]*/,
    /(?:^|\s)\.[A-Za-z_][\w-]*/,
  ];
  const fields = plan.scenarios.flatMap((scenario) => [
    scenario.title,
    ...scenario.preconditions,
    ...scenario.steps.flatMap((step) => [step.intent, step.expectedObservation]),
    scenario.verificationStrategy,
    ...scenario.verificationChecks.flatMap((check) => [...check.expectedVisible, ...check.expectedAbsent]),
    ...scenario.relevantApplicationContext,
    ...scenario.unknownControlsToDiscover,
    scenario.expectedResult,
  ]);
  return fields.some((value) => forbiddenPatterns.some((pattern) => pattern.test(value)));
}

export function validateScenarioPlan(
  input: unknown,
  issue: NormalizedIssue,
  applicationContext: ApplicationContext,
): ScenarioPlan {
  const parsed = scenarioPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Gemini scenario plan failed validation: ${parsed.error.issues.map((entry) => `${entry.path.join(".")}: ${entry.message}`).join("; ")}`);
  }
  if (parsed.data.issueNumber !== issue.issueNumber) throw new Error("Gemini scenario plan references a different issue number.");
  const scenarioIds = parsed.data.scenarios.map((scenario) => scenario.id);
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error("Gemini scenario plan contains duplicate scenario IDs.");
  const known = new Set(issue.acceptanceCriteria.map((criterion) => criterion.id));
  const covered = new Set<string>();
  const observedAffordances = new Set(applicationContext.page.visibleSemanticControls.map((control) => {
    const attributes = control.observedAttributes.length > 0 ? ` (${control.observedAttributes.join(", ")})` : "";
    return `${control.role}: ${control.name}${attributes}`;
  }));
  const noAffordance = "No directly relevant affordance was observed.";
  for (const scenario of parsed.data.scenarios) {
    for (const id of scenario.acceptanceCriteriaIds) {
      if (!known.has(id)) throw new Error(`Gemini scenario plan references unknown acceptance criterion ${id}.`);
      covered.add(id);
    }
    if (scenario.acceptanceCriteriaIds.length !== 1) {
      throw new Error(`Scenario ${scenario.id} must verify exactly one acceptance criterion independently; establish its prerequisite state within its own steps.`);
    }
  }
  const missing = [...known].filter((id) => !covered.has(id));
  if (missing.length > 0) throw new Error(`Gemini scenario plan does not cover: ${missing.join(", ")}.`);
  for (const scenario of parsed.data.scenarios) {
    for (const affordance of scenario.relevantApplicationContext) {
      if (affordance !== noAffordance && !observedAffordances.has(affordance)) {
        throw new Error(`Gemini scenario plan claims an unobserved application affordance: ${affordance}.`);
      }
    }
    const scenarioCriteria = new Set(scenario.acceptanceCriteriaIds);
    const checkedCriteria = new Set<string>();
    for (const check of scenario.verificationChecks) {
      if (!scenarioCriteria.has(check.acceptanceCriterionId)) {
        throw new Error(`Verification check references criterion ${check.acceptanceCriterionId} outside its scenario.`);
      }
      checkedCriteria.add(check.acceptanceCriterionId);
      if (check.kind === "visible" && (check.expectedVisible.length === 0 || check.expectedAbsent.length > 0)) {
        throw new Error(`Visible verification for ${check.acceptanceCriterionId} requires visible text and no absent-text conditions.`);
      }
      if (check.kind === "checked" && (check.expectedVisible.length !== 1 || check.expectedAbsent.length > 0)) {
        throw new Error(`Checked-state verification for ${check.acceptanceCriterionId} requires exactly one visible subject.`);
      }
      if (check.kind === "absent_after_seen" && (check.expectedVisible.length !== 1 || check.expectedAbsent.length !== 1)) {
        throw new Error(`Absence verification for ${check.acceptanceCriterionId} requires one subject to observe and verify absent.`);
      }
      if (check.kind === "filter" && (check.expectedVisible.length === 0 || check.expectedAbsent.length === 0)) {
        throw new Error(`Filter verification for ${check.acceptanceCriterionId} requires both included and excluded text.`);
      }
    }
    const missingChecks = scenario.acceptanceCriteriaIds.filter((id) => !checkedCriteria.has(id));
    if (missingChecks.length > 0) throw new Error(`Scenario ${scenario.id} lacks host-verifiable checks for: ${missingChecks.join(", ")}.`);
  }
  if (hasUnsupportedReferenceOrSelector(parsed.data)) {
    throw new Error("Gemini scenario plan contains a CSS/XPath selector, script, or stale Playwright MCP element reference.");
  }
  return parsed.data;
}

export function selectScenarios(scenarios: ScenarioPlan["scenarios"], scenarioId?: string): ScenarioPlan["scenarios"] {
  if (!scenarioId) return scenarios;
  const selected = scenarios.filter((scenario) => scenario.id === scenarioId);
  if (selected.length === 0) throw new Error(`Scenario "${scenarioId}" was not found in the generated plan.`);
  return selected;
}

export async function createScenarioPlan(
  agent: PlannerAgent,
  issue: NormalizedIssue,
  applicationContextInputValue: ApplicationContext,
): Promise<ScenarioPlan> {
  const applicationContext = validateApplicationContext(applicationContextInputValue, issue);
  const prompt = plannerPrompt(issue, applicationContext);
  let previousError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: unknown;
    try {
      response = await agent.generateJson(
        attempt === 0 ? prompt : `${prompt}\nThe previous response was rejected: ${previousError}. Correct the schema and coverage; return valid JSON only.`,
        plannerJsonSchema,
        undefined,
        "planner",
      );
    } catch (error) {
      if (isGeminiServiceError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid JSON/i.test(message)) {
        previousError = message;
        if (attempt === 0) continue;
        break;
      }
      throw error;
    }
    try {
      return validateScenarioPlan(response, issue, applicationContext);
    } catch (error) {
      previousError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Gemini planning failed after one format-repair attempt: ${previousError}`);
}

async function readPlanCache(path: string): Promise<{ cache: z.infer<typeof cacheSchema> | null; invalidationReason?: string }> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { cache: null, invalidationReason: "No validated plan cache exists." };
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { cache: null, invalidationReason: "Cached plan file contains invalid JSON." };
  }
  const parsed = cacheSchema.safeParse(data);
  if (!parsed.success) return { cache: null, invalidationReason: "Cached plan metadata is invalid." };
  return { cache: parsed.data };
}

function acceptanceCriteriaMapping(plan: ScenarioPlan): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};
  for (const scenario of plan.scenarios) {
    for (const criterionId of scenario.acceptanceCriteriaIds) {
      mapping[criterionId] ??= [];
      mapping[criterionId]!.push(scenario.id);
    }
  }
  return mapping;
}

export async function generateScenarioPlan(
  agent: PlannerAgent,
  issue: NormalizedIssue,
  applicationContextInputValue: ApplicationContext,
  runId: string,
  options: ScenarioGenerationOptions = {},
): Promise<ScenarioGenerationArtifact> {
  const applicationContext = validateApplicationContext(applicationContextInputValue, issue);
  const issueFingerprint = fingerprint(issue);
  const applicationFingerprint = fingerprint(applicationContextInput(applicationContext));
  const contractFingerprint = planningContractFingerprint(issue, applicationContext);
  const cachePath = resolve(options.cachePath ?? resolve(evidenceDirectory, "scenario-plan-cache.json"));
  const artifactPath = resolve(options.artifactPath ?? resolve(evidenceDirectory, "generated-scenarios.json"));
  const logAction = options.logAction ?? appendActionLog;
  const cached = await readPlanCache(cachePath);
  let invalidationReason = cached.invalidationReason;
  let source: "gemini" | "validated-cache" = "gemini";
  let plan: ScenarioPlan | undefined;
  let generatedAt: string | undefined;

  if (cached.cache) {
    if (cached.cache.issueFingerprint !== issueFingerprint) invalidationReason = "Normalized issue or acceptance criteria changed.";
    else if (cached.cache.applicationContextFingerprint !== applicationFingerprint) invalidationReason = "Observed application context changed.";
    else if (cached.cache.modelName !== agent.model) invalidationReason = "Gemini model changed.";
    else if (cached.cache.planningContractFingerprint !== contractFingerprint) invalidationReason = "Planning contract, prompt, or response schema changed.";
    else {
      try {
        plan = validateScenarioPlan(cached.cache.plan, issue, applicationContext);
        generatedAt = cached.cache.generatedAt;
        source = "validated-cache";
      } catch (error) {
        invalidationReason = `Cached plan failed validation: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  if (source === "gemini") {
    plan = await createScenarioPlan(agent, issue, applicationContext);
    generatedAt = new Date().toISOString();
    await writeFile(cachePath, `${JSON.stringify({
      issueFingerprint,
      applicationContextFingerprint: applicationFingerprint,
      planningContractFingerprint: contractFingerprint,
      modelName: agent.model,
      generatedAt,
      plan,
    }, null, 2)}\n`, "utf8");
  }
  if (!plan || !generatedAt) throw new Error("Scenario planner did not produce a validated plan and generation timestamp.");

  const artifact = generationArtifactSchema.parse({
    runId,
    issueNumber: issue.issueNumber,
    modelName: agent.model,
    planningContractFingerprint: contractFingerprint,
    applicationContextReference: {
      path: options.applicationContextPath ?? "evidence/application-context.json",
      runId: applicationContext.runId,
      fingerprint: applicationFingerprint,
    },
    generatedAt,
    artifactCreatedAt: new Date().toISOString(),
    source,
    cache: {
      status: source === "validated-cache" ? "HIT" : "MISS",
      ...(source === "gemini" && invalidationReason ? { invalidationReason } : {}),
    },
    scenarios: plan.scenarios,
    acceptanceCriteriaMapping: acceptanceCriteriaMapping(plan),
  });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await logAction({
    timestamp: new Date().toISOString(),
    runId,
    event: "scenario_plan_ready",
    source,
    cacheStatus: artifact.cache.status,
    planningContractFingerprint: contractFingerprint,
    ...(artifact.cache.invalidationReason ? { cacheInvalidationReason: artifact.cache.invalidationReason } : {}),
    applicationContextRunId: applicationContext.runId,
    scenarioCount: plan.scenarios.length,
  });
  return artifact;
}
