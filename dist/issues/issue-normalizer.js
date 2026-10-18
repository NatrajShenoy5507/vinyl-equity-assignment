import { normalizedIssueSchema } from "../schemas.js";
export function normalizeIssue(input) {
    const parsed = normalizedIssueSchema.safeParse(input);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "issue"}: ${issue.message}`).join("; ");
        throw new Error(`Issue validation failed: ${detail}`);
    }
    return parsed.data;
}
export function parseAcceptanceCriteria(body) {
    const section = body.match(/(?:^|\n)#{1,6}\s*(?:acceptance criteria|acceptance requirements)\s*\n([\s\S]*?)(?=\n#{1,6}\s|\s*$)/i)?.[1];
    if (!section)
        throw new Error("GitHub issue body is missing an 'Acceptance Criteria' section.");
    const criteria = [...section.matchAll(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(?:\*\*)?(AC-[\w.-]+)(?:\*\*)?\s*[:.-]\s*(?:\*\*)?(.+?)(?:\*\*)?\s*$/gm)]
        .map((match) => ({ id: match[1], description: match[2].replace(/^\*\*|\*\*$/g, "").trim() }));
    if (criteria.length === 0)
        throw new Error("No acceptance criteria in the issue body match '- AC-01: description'.");
    return criteria;
}
