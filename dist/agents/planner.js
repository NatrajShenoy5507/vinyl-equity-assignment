import { scenarioPlanSchema } from "../schemas.js";
import { plannerPrompt } from "../prompts/planner-prompt.js";
const plannerJsonSchema = {
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
                    acceptanceCriteriaIds: { type: "array", items: { type: "string" } },
                    preconditions: { type: "array", items: { type: "string" } },
                    steps: { type: "array", items: { type: "object", properties: { intent: { type: "string" }, expectedObservation: { type: "string" } }, required: ["intent", "expectedObservation"] } },
                    expectedResult: { type: "string" },
                },
                required: ["id", "title", "acceptanceCriteriaIds", "preconditions", "steps", "expectedResult"],
            },
        },
    },
    required: ["issueNumber", "scenarios"],
};
export function validateScenarioPlan(input, issue) {
    const parsed = scenarioPlanSchema.safeParse(input);
    if (!parsed.success)
        throw new Error(`Gemini scenario plan failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    if (parsed.data.issueNumber !== issue.issueNumber)
        throw new Error("Gemini scenario plan references a different issue number.");
    const scenarioIds = parsed.data.scenarios.map((scenario) => scenario.id);
    if (new Set(scenarioIds).size !== scenarioIds.length)
        throw new Error("Gemini scenario plan contains duplicate scenario IDs.");
    const known = new Set(issue.acceptanceCriteria.map((criterion) => criterion.id));
    const covered = new Set();
    for (const scenario of parsed.data.scenarios) {
        for (const id of scenario.acceptanceCriteriaIds) {
            if (!known.has(id))
                throw new Error(`Gemini scenario plan references unknown acceptance criterion ${id}.`);
            covered.add(id);
        }
    }
    const missing = [...known].filter((id) => !covered.has(id));
    if (missing.length > 0)
        throw new Error(`Gemini scenario plan does not cover: ${missing.join(", ")}.`);
    return parsed.data;
}
export async function createScenarioPlan(agent, issue) {
    const prompt = plannerPrompt(issue);
    let previousError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await agent.generateJson(attempt === 0 ? prompt : `${prompt}\nThe previous response was rejected: ${previousError}. Correct the schema/coverage and return valid JSON only.`, plannerJsonSchema);
        try {
            return validateScenarioPlan(response, issue);
        }
        catch (error) {
            previousError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(`Gemini planning failed after one format-repair attempt: ${previousError}`);
}
