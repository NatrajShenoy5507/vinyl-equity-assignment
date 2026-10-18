import { z } from "zod";
const acceptanceCriterionSchema = z.object({
    id: z.string().trim().min(1),
    description: z.string().trim().min(1),
});
export const normalizedIssueSchema = z.object({
    issueNumber: z.number().int().positive(),
    title: z.string().trim().min(1),
    status: z.string().trim().min(1).transform((status) => status.toUpperCase() === "RFQA" ? "RFQA" : "OTHER"),
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
    })).min(1),
    expectedResult: z.string().trim().min(1),
});
export const scenarioPlanSchema = z.object({
    issueNumber: z.number().int().positive(),
    scenarios: z.array(plannedScenarioSchema).min(1),
});
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
