import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";
import type {
  AcceptanceCriterionTrace,
  EvidenceArtifact,
  NormalizedIssue,
  RunReport,
  ScenarioResult,
  ScenarioStatus,
} from "../schemas.js";
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

export function buildAcceptanceCriteriaTrace(
  acceptanceCriteria: NormalizedIssue["acceptanceCriteria"],
  scenarios: ScenarioResult[],
): AcceptanceCriterionTrace[] {
  return acceptanceCriteria.map((criterion) => {
    const covering = scenarios.filter((scenario) => scenario.acceptanceCriteriaIds.includes(criterion.id));
    const scenarioIds = covering.map((scenario) => scenario.scenarioId);
    const hostChecks = covering.flatMap((scenario) =>
      (scenario.hostVerification ?? []).filter((check) => check.acceptanceCriterionId === criterion.id));
    const evidence = [
      ...new Set([
        ...hostChecks.flatMap((check) => check.evidence),
        ...covering.flatMap((scenario) => scenario.evidence),
      ]),
    ];

    if (hostChecks.some((check) => check.status === "FAIL")) {
      return { id: criterion.id, description: criterion.description, scenarioIds, status: "FAIL", evidence };
    }
    if (hostChecks.some((check) => check.status === "BLOCKED")) {
      return { id: criterion.id, description: criterion.description, scenarioIds, status: "BLOCKED", evidence };
    }
    if (hostChecks.length > 0 && hostChecks.every((check) => check.status === "PASS")) {
      return { id: criterion.id, description: criterion.description, scenarioIds, status: "PASS", evidence };
    }
    return { id: criterion.id, description: criterion.description, scenarioIds, status: "UNVERIFIED", evidence };
  });
}

export async function buildArtifactInventory(candidates: Array<{ label: string; path: string }>): Promise<EvidenceArtifact[]> {
  const artifacts: EvidenceArtifact[] = [];
  for (const candidate of candidates) {
    let available = false;
    try {
      await access(candidate.path);
      available = true;
    } catch {
      available = false;
    }
    artifacts.push({ label: candidate.label, path: candidate.path, available });
  }
  return artifacts;
}

export function runEvidenceDirectory(runId: string): string {
  return resolve(evidenceDirectory, "runs", runId);
}

export async function dualWriteJson(runId: string, fileName: string, contents: string): Promise<{ runPath: string; rootPath: string }> {
  const runDir = runEvidenceDirectory(runId);
  await mkdir(runDir, { recursive: true });
  const runPath = resolve(runDir, fileName);
  const rootPath = resolve(evidenceDirectory, fileName);
  await writeFile(runPath, contents, "utf8");
  await writeFile(rootPath, contents, "utf8");
  return { runPath, rootPath };
}

export async function dualWriteExistingFile(runId: string, sourcePath: string, fileName = basename(sourcePath)): Promise<void> {
  const runDir = runEvidenceDirectory(runId);
  await mkdir(runDir, { recursive: true });
  const runPath = resolve(runDir, fileName);
  const rootPath = resolve(evidenceDirectory, fileName);
  try {
    await access(sourcePath);
  } catch {
    return;
  }
  if (resolve(sourcePath) !== resolve(runPath)) await copyFile(sourcePath, runPath);
  if (resolve(sourcePath) !== resolve(rootPath) && resolve(runPath) !== resolve(rootPath)) {
    await copyFile(sourcePath, rootPath);
  } else if (resolve(sourcePath) === resolve(runPath) && resolve(rootPath) !== resolve(runPath)) {
    await copyFile(runPath, rootPath);
  }
}

export function buildEnvironment(headless?: boolean): RunReport["environment"] {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    ...(headless === undefined ? {} : { headless }),
  };
}

export async function writeReport(report: RunReport): Promise<void> {
  await mkdir(resolve(evidenceDirectory, "screenshots", report.runId), { recursive: true });
  await mkdir(runEvidenceDirectory(report.runId), { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdown(report);
  await dualWriteJson(report.runId, "report.json", json);
  await dualWriteJson(report.runId, "report.md", markdown);
}

function evidenceLink(file: string): string {
  const path = relative(evidenceDirectory, file).replaceAll("\\", "/");
  if (path.startsWith("..")) return file.replaceAll("\\", "/");
  return `./${path}`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "unavailable";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  const hasRevalidation = report.scenarios.some((scenario) => scenario.revalidation);

  lines.push(
    `# Autonomous UI QA report`,
    "",
    "## Executive summary",
    "",
    `- **Overall status:** **${report.status}**`,
    `- **Totals:** PASS ${report.totals.PASS}; FAIL ${report.totals.FAIL}; BLOCKED ${report.totals.BLOCKED}; SKIPPED ${report.totals.SKIPPED}`,
    `- **Run ID:** \`${report.runId}\``,
    `- **Outcome:** ${executiveOutcome(report)}`,
    "",
    "## Issue and target application",
    "",
    `- **Issue:** #${report.issueNumber} — ${report.issueTitle}`,
    `- **Source:** ${report.source}`,
    `- **Target URL:** ${report.targetUrl}`,
    `- **Started:** ${report.startedAt}`,
    `- **Completed:** ${report.completedAt}`,
    "",
    "## Execution environment and model",
    "",
    `- **Model:** ${report.model}`,
  );
  if (report.environment) {
    lines.push(
      `- **Node.js:** ${report.environment.nodeVersion}`,
      `- **Platform:** ${report.environment.platform} (${report.environment.architecture})`,
    );
    if (report.environment.headless !== undefined) {
      lines.push(`- **Headless browser:** ${report.environment.headless ? "yes" : "no"}`);
    }
  } else {
    lines.push("- **Environment details:** unavailable");
  }
  lines.push("");

  if (report.blocker) {
    lines.push("> **Infrastructure / run blocker:** " + report.blocker, "");
  }

  lines.push("## Six-phase execution summary", "");
  if (report.phases && report.phases.length > 0) {
    lines.push(
      "| Phase | Name | Status | Duration | Artifacts | Errors / notes |",
      "|---:|---|---|---|---|---|",
    );
    for (const phase of report.phases) {
      lines.push(
        `| ${phase.phase} | ${escapeCell(phase.name)} | **${phase.status}** | ${formatDuration(phase.durationMs)} | ${
          phase.outputArtifacts.length > 0
            ? phase.outputArtifacts.map((path) => `\`${relativePath(path)}\``).join(", ")
            : "—"
        } | ${
          phase.errors.length > 0 ? escapeCell(phase.errors.join("; ")) : "—"
        } |`,
      );
    }
  } else {
    lines.push("_Phase execution summary unavailable._");
  }
  lines.push("");

  lines.push("## Generated scenario summary", "");
  if (report.scenarios.length === 0) {
    lines.push("_No scenarios were generated or executed._", "");
  } else {
    lines.push("| Scenario | Title | Acceptance criteria | Status |", "|---|---|---|---|");
    for (const scenario of report.scenarios) {
      lines.push(
        `| ${scenario.scenarioId} | ${escapeCell(scenario.title)} | ${
          scenario.acceptanceCriteriaIds.length > 0 ? scenario.acceptanceCriteriaIds.join(", ") : "—"
        } | **${scenario.status}** |`,
      );
    }
    lines.push("");
  }

  lines.push("## Acceptance criteria traceability", "");
  if (report.acceptanceCriteria && report.acceptanceCriteria.length > 0) {
    lines.push(
      "| Criterion | Description | Scenarios | Verification result | Evidence |",
      "|---|---|---|---|---|",
    );
    for (const criterion of report.acceptanceCriteria) {
      lines.push(
        `| ${criterion.id} | ${escapeCell(criterion.description)} | ${
          criterion.scenarioIds.length > 0 ? criterion.scenarioIds.join(", ") : "uncovered"
        } | **${criterion.status}** | ${
          criterion.evidence.length > 0
            ? criterion.evidence.map((file) => `[${relativePath(file)}](${evidenceLink(file)})`).join(", ")
            : "unavailable"
        } |`,
      );
    }
    const unverified = report.acceptanceCriteria.filter((criterion) => criterion.status === "UNVERIFIED");
    if (unverified.length > 0) {
      lines.push(
        "",
        `Uncovered or unverified criteria: ${unverified.map((criterion) => criterion.id).join(", ")}.`,
        "A criterion is not marked PASS solely because a generated scenario references it; host-verified checks are required.",
      );
    }
  } else {
    lines.push("_Acceptance criteria traceability unavailable for this run._");
  }
  lines.push("");

  lines.push("## Scenario execution results", "");
  if (report.scenarios.length === 0) {
    lines.push("_No scenario execution results._", "");
  }
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.scenarioId} — ${scenario.title} (**${scenario.status}**)`, "");
    lines.push(`- **Acceptance criteria:** ${scenario.acceptanceCriteriaIds.length > 0 ? scenario.acceptanceCriteriaIds.join(", ") : "none"}`);
    if (scenario.preconditions && scenario.preconditions.length > 0) {
      lines.push("- **Preconditions:**");
      for (const precondition of scenario.preconditions) lines.push(`  - ${precondition}`);
    }
    if (scenario.intendedSteps && scenario.intendedSteps.length > 0) {
      lines.push("- **Intended steps:**");
      for (const step of scenario.intendedSteps) {
        lines.push(`  - Intent: ${step.intent}`);
        lines.push(`    - Expected observation: ${step.expectedObservation}`);
      }
    }
    if (scenario.verificationStrategy) {
      lines.push(`- **Verification strategy:** ${scenario.verificationStrategy}`);
    }
    lines.push(`- **Expected result:** ${scenario.expected}`);
    lines.push(`- **Actual observed result:** ${scenario.observed}`);
    lines.push(`- **Reason:** ${scenario.reason}`);
    lines.push(`- **Execution duration:** ${formatDuration(scenario.executionDurationMs)}`);
    lines.push(
      `- **Gemini requests / browser actions / recoveries:** ${
        scenario.modelRequestCount === undefined ? "unavailable" : String(scenario.modelRequestCount)
      } / ${scenario.actionCount} / ${scenario.recoveryCount}`,
    );
    if (scenario.hostVerifiedFailure !== undefined) {
      lines.push(`- **Host-verified functional failure:** ${scenario.hostVerifiedFailure ? "yes" : "no"}`);
    }
    if (scenario.browserActions && scenario.browserActions.length > 0) {
      lines.push("- **Actual browser actions:**");
      for (const action of scenario.browserActions) {
        lines.push(`  - \`${action.toolName}\` (${action.status}): ${action.rationale}`);
        if (action.preActionObservation) lines.push(`    - Pre: ${truncate(action.preActionObservation, 240)}`);
        if (action.postActionObservation) lines.push(`    - Post: ${truncate(action.postActionObservation, 240)}`);
      }
    } else {
      lines.push("- **Actual browser actions:** unavailable");
    }
    if (scenario.hostVerification && scenario.hostVerification.length > 0) {
      lines.push("- **Host-verified assertion outcomes:**");
      for (const check of scenario.hostVerification) {
        lines.push(`  - ${check.acceptanceCriterionId}: **${check.status}** — ${check.reason}`);
      }
    } else {
      lines.push("- **Host-verified assertion outcomes:** unavailable");
    }
    if (scenario.evidence.length > 0) {
      lines.push("- **Screenshots:**");
      for (const file of scenario.evidence) {
        lines.push(`  - [${relativePath(file)}](${evidenceLink(file)})`);
      }
    } else {
      lines.push("- **Screenshots:** unavailable");
    }
    lines.push("");
  }

  lines.push("## Revalidation details", "");
  if (hasRevalidation) {
    for (const scenario of report.scenarios) {
      if (!scenario.revalidation) continue;
      const retry = scenario.revalidation.attemptResult;
      lines.push(
        `### ${scenario.scenarioId}`,
        "",
        `- **Classification:** **${scenario.revalidation.classification}**`,
        `- **Original run:** \`${scenario.revalidation.originalRunId}\` — **${scenario.revalidation.originalResult.status}**`,
        `- **Original failure:** ${scenario.revalidation.originalFailureReason}`,
        `- **Revalidation run:** \`${scenario.revalidation.revalidationRunId}\` — **${retry.status}**`,
        `- **Retry reason:** ${retry.reason}`,
        `- **Attempt count:** ${scenario.revalidation.attemptCount}`,
        `- **Retry actions / recoveries:** ${retry.actionCount} / ${retry.recoveryCount}`,
        `- **Original scenario status retained in totals:** **FAIL** (revalidation does not convert the original result)`,
      );
      if (retry.evidence.length > 0) {
        lines.push("- **Revalidation screenshots:**");
        for (const file of retry.evidence) {
          lines.push(`  - [${relativePath(file)}](${evidenceLink(file)})`);
        }
      } else {
        lines.push("- **Revalidation screenshots:** unavailable");
      }
      lines.push("");
    }
  } else {
    lines.push(
      "Revalidation was not required or not executed for this run. Phase 5 remains NOT_RUN when no host-verified functional FAIL occurs; that is normal and is not a product defect.",
      "",
    );
  }

  lines.push("## Screenshots and evidence references", "");
  if (report.artifacts && report.artifacts.length > 0) {
    lines.push("| Artifact | Path | Available |", "|---|---|---|");
    for (const artifact of report.artifacts) {
      const display = relativePath(artifact.path);
      lines.push(
        `| ${escapeCell(artifact.label)} | ${
          artifact.available ? `[${display}](${evidenceLink(artifact.path)})` : `\`${display}\``
        } | ${artifact.available ? "yes" : "no"} |`,
      );
    }
  } else {
    lines.push("_Artifact inventory unavailable._");
  }
  lines.push("");

  lines.push("## Infrastructure blockers and limitations", "");
  if (report.blocker) {
    lines.push(`- ${report.blocker}`);
  } else {
    const blockedPhases = (report.phases ?? []).filter((phase) => phase.status === "BLOCKED" || phase.status === "FAILED");
    if (blockedPhases.length > 0) {
      for (const phase of blockedPhases) {
        lines.push(`- Phase ${phase.phase} (${phase.name}): **${phase.status}**${phase.errors.length > 0 ? ` — ${phase.errors.join("; ")}` : ""}`);
      }
    } else {
      lines.push("- No infrastructure blocker was recorded for this run.");
    }
  }
  lines.push(
    "- Gemini API 429/503/504 responses are treated as infrastructure BLOCKED, not product FAIL.",
    "- Missing evidence is labeled unavailable; the report never fabricates PASS, FAIL, observations, or screenshots.",
    "- Secrets, tokens, and API keys are not written to reports.",
    "",
    "## Final status",
    "",
    `**${report.status}** — PASS ${report.totals.PASS}; FAIL ${report.totals.FAIL}; BLOCKED ${report.totals.BLOCKED}; SKIPPED ${report.totals.SKIPPED}`,
    "",
  );

  return lines.join("\n");
}

function executiveOutcome(report: RunReport): string {
  if (report.blocker) return `Run ended with an infrastructure or workflow blocker: ${report.blocker}`;
  if (report.status === "PASS") return "All executed scenarios passed host-verified checks (or were intentionally skipped).";
  if (report.status === "FAIL") return "At least one scenario failed a host-verified functional assertion. Original FAIL values are retained even when revalidation is inconsistent.";
  if (report.status === "SKIPPED") return "The run was skipped before Gemini or browser startup (for example, RFQA readiness).";
  return "The run did not complete verified product assertions for every scenario; see blockers and scenario details.";
}

function relativePath(file: string): string {
  const path = relative(evidenceDirectory, file).replaceAll("\\", "/");
  return path.startsWith("..") ? file.replaceAll("\\", "/") : path;
}

function truncate(value: string, max: number): string {
  const normalized = value.replaceAll("\n", " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}
