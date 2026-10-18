import { describe, expect, it } from "vitest";
import { normalizeIssue, parseAcceptanceCriteria } from "../src/issues/issue-normalizer.js";

const issue = {
  issueNumber: 4,
  title: "Example",
  status: "RFQA",
  targetUrl: "https://example.test/",
  description: "A user story.",
  acceptanceCriteria: [{ id: "AC-01", description: "Item is visible." }],
};

describe("issue normalization", () => {
  it("accepts a valid RFQA issue", () => expect(normalizeIssue(issue).status).toBe("RFQA"));
  it("normalizes RFQA status case-insensitively", () => expect(normalizeIssue({ ...issue, status: "rfqa" }).status).toBe("RFQA"));
  it("accepts a non-RFQA issue", () => expect(normalizeIssue({ ...issue, status: "OTHER" }).status).toBe("OTHER"));
  it("rejects invalid URLs and empty criteria", () => {
    expect(() => normalizeIssue({ ...issue, targetUrl: "not a URL" })).toThrow(/Issue validation failed/);
    expect(() => normalizeIssue({ ...issue, acceptanceCriteria: [] })).toThrow(/Issue validation failed/);
  });
  it("rejects duplicate criterion IDs", () => {
    expect(() => normalizeIssue({ ...issue, acceptanceCriteria: [...issue.acceptanceCriteria, ...issue.acceptanceCriteria] })).toThrow(/unique/);
  });
  it("extracts explicitly identified ACs from a GitHub issue section", () => {
    expect(parseAcceptanceCriteria("## Acceptance Criteria\n- AC-01: Item visible.\n- **AC-02:** Item removable.\n\n## Notes\nIgnore.")).toEqual([
      { id: "AC-01", description: "Item visible." },
      { id: "AC-02", description: "Item removable." },
    ]);
  });
  it("rejects missing or unsupported AC sections", () => {
    expect(() => parseAcceptanceCriteria("No section")).toThrow(/missing/);
    expect(() => parseAcceptanceCriteria("## Acceptance Criteria\n- Item visible")).toThrow(/No acceptance criteria/);
  });
});
