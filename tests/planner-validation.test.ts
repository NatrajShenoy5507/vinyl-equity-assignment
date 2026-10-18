import { describe, expect, it } from "vitest";
import { validateScenarioPlan } from "../src/agents/planner.js";
import type { NormalizedIssue } from "../src/schemas.js";

const issue: NormalizedIssue = {
  issueNumber: 1, title: "Todo", status: "RFQA", targetUrl: "https://example.test/",
  description: "Story", acceptanceCriteria: [
    { id: "AC-01", description: "Create item." },
    { id: "AC-02", description: "Delete item." },
  ],
};
const scenario = {
  id: "SC-01", title: "Create and delete", acceptanceCriteriaIds: ["AC-01", "AC-02"],
  preconditions: [], steps: [{ intent: "Create", expectedObservation: "Visible" }], expectedResult: "Item is removed",
};

describe("scenario plan validation", () => {
  it("accepts schema-valid plans with complete AC coverage", () => {
    expect(validateScenarioPlan({ issueNumber: 1, scenarios: [scenario] }, issue).scenarios).toHaveLength(1);
  });
  it("rejects invalid JSON shapes, missing coverage, unknown ACs and duplicate IDs", () => {
    expect(() => validateScenarioPlan({ nope: true }, issue)).toThrow(/failed validation/);
    expect(() => validateScenarioPlan({ issueNumber: 1, scenarios: [{ ...scenario, acceptanceCriteriaIds: ["AC-01"] }] }, issue)).toThrow(/does not cover/);
    expect(() => validateScenarioPlan({ issueNumber: 1, scenarios: [{ ...scenario, acceptanceCriteriaIds: ["AC-01", "AC-99"] }] }, issue)).toThrow(/unknown/);
    expect(() => validateScenarioPlan({ issueNumber: 1, scenarios: [scenario, scenario] }, issue)).toThrow(/duplicate/);
  });
});
