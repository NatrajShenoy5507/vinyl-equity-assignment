import { z } from "zod";

const acceptanceCriterionSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

export const verificationCheckSchema = z.object({
  acceptanceCriterionId: z.string().trim().min(1),
  kind: z.enum(["visible", "absent_after_seen", "checked", "filter"]),
  expectedVisible: z.array(z.string().trim().min(1)),
  expectedAbsent: z.array(z.string().trim().min(1)),
}).strict();

export const normalizedIssueSchema = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string().trim().min(1),
  status: z.string().trim().min(1).transform((status) => status.toUpperCase() === "RFQA" ? "RFQA" as const : "OTHER" as const),
  targetUrl: z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "Target URL must use HTTP or HTTPS."),
  description: z.string().trim().min(1),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
}).superRefine((issue, context) => {
  const ids = issue.acceptanceCriteria.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Acceptance criterion IDs must be unique.", path: ["acceptanceCriteria"] });
  }
});

export const plannedScenarioSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  acceptanceCriteriaIds: z.array(z.string().trim().min(1)).min(1),
  preconditions: z.array(z.string().trim().min(1)),
  steps: z.array(z.object({
    intent: z.string().trim().min(1),
    expectedObservation: z.string().trim().min(1),
  }).strict()).min(1),
  verificationStrategy: z.string().trim().min(1),
  verificationChecks: z.array(verificationCheckSchema).min(1),
  relevantApplicationContext: z.array(z.string().trim().min(1)).min(1),
  unknownControlsToDiscover: z.array(z.string().trim().min(1)),
  expectedResult: z.string().trim().min(1),
}).strict();

export const scenarioPlanSchema = z.object({
  issueNumber: z.number().int().positive(),
  scenarios: z.array(plannedScenarioSchema).min(1),
}).strict();

export const executorDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action"),
    toolName: z.string().trim().min(1),
    arguments: z.record(z.string(), z.unknown()),
    rationale: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal("finish"),
    assessments: z.array(z.object({
      acceptanceCriteriaId: z.string().trim().min(1),
      meets: z.boolean(),
      observedEvidence: z.string().trim().min(1),
      explanation: z.string().trim().min(1),
    })).min(1),
    rationale: z.string().trim().min(1),
  }),
]);

export const scenarioStatusSchema = z.enum(["PASS", "FAIL", "BLOCKED", "SKIPPED"]);

export type NormalizedIssue = z.infer<typeof normalizedIssueSchema>;
export type PlannedScenario = z.infer<typeof plannedScenarioSchema>;
export type ScenarioPlan = z.infer<typeof scenarioPlanSchema>;
export type ExecutorDecision = z.infer<typeof executorDecisionSchema>;
export type ScenarioStatus = z.infer<typeof scenarioStatusSchema>;

export type RevalidationClassification =
  | "CONFIRMED_FAILURE"
  | "FLAKY_OR_INCONSISTENT"
  | "REVALIDATION_INCONCLUSIVE";

export interface ScenarioRevalidation {
  originalRunId: string;
  revalidationRunId: string;
  attemptCount: 1;
  originalFailureReason: string;
  originalResult: Omit<ScenarioResult, "revalidation">;
  attemptResult: Omit<ScenarioResult, "revalidation">;
  classification: RevalidationClassification;
}

export interface ScenarioBrowserAction {
  toolName: string;
  arguments: Record<string, unknown>;
  rationale: string;
  status: "ok" | "error";
  result: string;
  preActionObservation?: string;
  postActionObservation?: string;
}

export interface ScenarioVerification {
  acceptanceCriterionId: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  reason: string;
  evidence: string[];
}

export interface ScenarioModelAssessment {
  acceptanceCriteriaId: string;
  meets: boolean;
  observedEvidence: string;
  explanation: string;
  evidenceStatus: "MATCHED_POST_ACTION" | "UNSUPPORTED";
  snapshotReferences: string[];
}

export interface ScenarioResult {
  scenarioId: string;
  title: string;
  acceptanceCriteriaIds: string[];
  status: ScenarioStatus;
  hostVerifiedFailure?: boolean;
  infrastructureError?: {
    source: "gemini" | "browser" | "executor";
    serviceFailure: boolean;
    httpStatus?: number;
    operation?: string;
  };
  expected: string;
  observed: string;
  reason: string;
  evidence: string[];
  actionCount: number;
  recoveryCount: number;
  preconditions?: string[];
  intendedSteps?: PlannedScenario["steps"];
  verificationStrategy?: string;
  browserActions?: ScenarioBrowserAction[];
  hostVerification?: ScenarioVerification[];
  modelAssessments?: ScenarioModelAssessment[];
  modelAssessmentWarnings?: string[];
  executionDurationMs?: number;
  modelRequestCount?: number;
  revalidation?: ScenarioRevalidation;
}

export type PhaseExecutionStatus = "COMPLETED" | "FAILED" | "BLOCKED" | "NOT_RUN";

export interface PhaseExecutionSummary {
  phase: number;
  name: string;
  status: PhaseExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outputArtifacts: string[];
  errors: string[];
}

export interface AcceptanceCriterionTrace {
  id: string;
  description: string;
  scenarioIds: string[];
  status: "PASS" | "FAIL" | "BLOCKED" | "UNVERIFIED";
  evidence: string[];
}

export interface EvidenceArtifact {
  label: string;
  path: string;
  available: boolean;
}

export interface RunReport {
  runId: string;
  source: "mock" | "github";
  model: string;
  issueNumber: number;
  issueTitle: string;
  targetUrl: string;
  status: ScenarioStatus;
  startedAt: string;
  completedAt: string;
  blocker?: string;
  scenarios: ScenarioResult[];
  totals: Record<ScenarioStatus, number>;
  phases?: PhaseExecutionSummary[];
  acceptanceCriteria?: AcceptanceCriterionTrace[];
  artifacts?: EvidenceArtifact[];
  environment?: {
    nodeVersion: string;
    platform: string;
    architecture: string;
    headless?: boolean;
  };
}
