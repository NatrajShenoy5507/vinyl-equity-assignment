import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { RunReport, ScenarioResult, ScenarioStatus } from "../schemas.js";
import { evidenceDirectory } from "./logger.js";

export function summarizeStatus(scenarios: ScenarioResult[], blocker?: string): ScenarioStatus {
  if (scenarios.some((scenario) => scenario.status === "FAIL")) return "FAIL";
  if (blocker || scenarios.some((scenario) => scenario.status === "BLOCKED")) return "BLOCKED";
  if (scenarios.length > 0 && scenarios.every((scenario) => scenario.status === "SKIPPED")) return "SKIPPED";
  if (scenarios.length > 0 && scenarios.every((scenario) => scenario.status === "PASS" || scenario.status === "SKIPPED")) return "PASS";
  return "BLOCKED";
}

export function buildReport(input: Omit<RunReport, "totals" | "status"> & { blocker?: string }): RunReport {
  const totals: Record<ScenarioStatus, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0 };
  for (const scenario of input.scenarios) totals[scenario.status] += 1;
  return { ...input, status: summarizeStatus(input.scenarios, input.blocker), totals };
}

export async function writeReport(report: RunReport): Promise<void> {
  await mkdir(resolve(evidenceDirectory, "screenshots", report.runId), { recursive: true });
  const jsonPath = resolve(evidenceDirectory, "report.json");
  const markdownPath = resolve(evidenceDirectory, "report.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
}

export function renderMarkdown(report: RunReport): string {
  const lines = [
    `# Autonomous UI QA report`,
    "",
    `- **Run:** \`${report.runId}\``,
    `- **Status:** **${report.status}**`,
    `- **Issue:** #${report.issueNumber} — ${report.issueTitle}`,
    `- **Source:** ${report.source}`,
    `- **Model:** ${report.model}`,
    `- **Target:** ${report.targetUrl}`,
    `- **Started:** ${report.startedAt}`,
    `- **Completed:** ${report.completedAt}`,
    `- **Totals:** PASS ${report.totals.PASS}; FAIL ${report.totals.FAIL}; BLOCKED ${report.totals.BLOCKED}; SKIPPED ${report.totals.SKIPPED}`,
    "",
  ];
  if (report.blocker) lines.push(`> **Blocker:** ${report.blocker}`, "");
  lines.push("| Scenario | Acceptance criteria | Status | Actions / recovery |", "|---|---|---:|---:|");
  for (const scenario of report.scenarios) {
    lines.push(`| ${scenario.scenarioId}: ${scenario.title} | ${scenario.acceptanceCriteriaIds.join(", ")} | **${scenario.status}** | ${scenario.actionCount} / ${scenario.recoveryCount} |`);
  }
  if (report.scenarios.length === 0) lines.push("| No scenarios executed | — | **BLOCKED/SKIPPED** | — |");
  lines.push("", "## Scenario evidence", "");
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.scenarioId} — ${scenario.status}`, "", `**Expected:** ${scenario.expected}`, "", `**Observed:** ${scenario.observed}`, "", `**Reason:** ${scenario.reason}`, "");
    if (scenario.evidence.length > 0) {
      lines.push("**Screenshots:**", "");
      for (const file of scenario.evidence) {
        const path = relative(evidenceDirectory, file).replaceAll("\\", "/");
        lines.push(`- [${path}](./${path})`);
      }
      lines.push("");
    }
  }
  lines.push("## Logs", "", "- [action-log.ndjson](./action-log.ndjson)", "");
  return lines.join("\n");
}
