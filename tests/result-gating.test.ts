import { describe, expect, it } from "vitest";
import { executorDecisionSchema } from "../src/schemas.js";
import { buildReport, summarizeStatus } from "../src/evidence/reporter.js";

describe("evidence and outcome gates", () => {
  it("rejects model-provided statuses that bypass the evidence schema", () => {
    expect(executorDecisionSchema.safeParse({ kind: "finish", status: "PASS" }).success).toBe(false);
  });
  it("keeps observed failures, blockers, and skips distinct", () => {
    expect(summarizeStatus([{ status: "FAIL" } as never])).toBe("FAIL");
    expect(summarizeStatus([{ status: "BLOCKED" } as never])).toBe("BLOCKED");
    expect(summarizeStatus([{ status: "SKIPPED" } as never])).toBe("SKIPPED");
  });
  it("does not count a skipped result as a pass", () => {
    const report = buildReport({
      runId: "run", source: "mock", model: "test", issueNumber: 1, issueTitle: "test",
      targetUrl: "https://example.test/", startedAt: "", completedAt: "",
      scenarios: [{ status: "SKIPPED" } as never],
    });
    expect(report.status).toBe("SKIPPED");
    expect(report.totals.PASS).toBe(0);
  });
});
