import { describe, expect, it } from "vitest";
import { buildReport, renderMarkdown } from "../src/evidence/reporter.js";

describe("report generation", () => {
  it("reports independent outcome totals and links only supplied evidence", () => {
    const report = buildReport({
      runId: "run1", source: "mock", model: "gemini-test", issueNumber: 1, issueTitle: "Todos",
      targetUrl: "https://example.test/", startedAt: "start", completedAt: "end",
      scenarios: [{
        scenarioId: "SC-01", title: "Create", acceptanceCriteriaIds: ["AC-01"], status: "BLOCKED",
        expected: "Item visible", observed: "No execution", reason: "Missing API key",
        evidence: [], actionCount: 0, recoveryCount: 0,
      }],
    });
    expect(report.totals).toEqual({ PASS: 0, FAIL: 0, BLOCKED: 1, SKIPPED: 0 });
    expect(renderMarkdown(report)).toContain("Missing API key");
    expect(renderMarkdown(report)).not.toContain("screenshots/");
  });
});
