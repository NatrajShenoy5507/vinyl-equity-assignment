import type { PhaseExecutionStatus, PhaseExecutionSummary } from "../schemas.js";

export const PHASE_NAMES = [
  "Requirement Discovery",
  "Application Exploration",
  "Scenario Generation",
  "Autonomous Execution",
  "Conditional Failure Revalidation",
  "Final Reporting",
] as const;

export type PhaseNumber = 1 | 2 | 3 | 4 | 5 | 6;

interface PhaseState {
  phase: PhaseNumber;
  name: string;
  status: PhaseExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outputArtifacts: string[];
  errors: string[];
}

export class PhaseLedger {
  private readonly phases = new Map<PhaseNumber, PhaseState>();

  constructor() {
    for (let phase = 1; phase <= 6; phase += 1) {
      const number = phase as PhaseNumber;
      this.phases.set(number, {
        phase: number,
        name: PHASE_NAMES[phase - 1]!,
        status: "NOT_RUN",
        outputArtifacts: [],
        errors: [],
      });
    }
  }

  start(phase: PhaseNumber, startedAt = new Date().toISOString()): void {
    const entry = this.require(phase);
    entry.startedAt = startedAt;
    entry.completedAt = undefined;
    entry.durationMs = undefined;
    entry.status = "NOT_RUN";
    entry.errors = [];
  }

  complete(
    phase: PhaseNumber,
    status: Exclude<PhaseExecutionStatus, "NOT_RUN">,
    options: {
      completedAt?: string;
      outputArtifacts?: string[];
      errors?: string[];
    } = {},
  ): void {
    const entry = this.require(phase);
    const completedAt = options.completedAt ?? new Date().toISOString();
    entry.status = status;
    entry.completedAt = completedAt;
    if (entry.startedAt) {
      const durationMs = Date.parse(completedAt) - Date.parse(entry.startedAt);
      if (Number.isFinite(durationMs) && durationMs >= 0) entry.durationMs = durationMs;
    }
    if (options.outputArtifacts) entry.outputArtifacts = [...options.outputArtifacts];
    if (options.errors) entry.errors = [...options.errors];
  }

  markNotRun(phase: PhaseNumber, reason?: string): void {
    const entry = this.require(phase);
    entry.status = "NOT_RUN";
    entry.startedAt = undefined;
    entry.completedAt = undefined;
    entry.durationMs = undefined;
    entry.outputArtifacts = [];
    entry.errors = reason ? [reason] : [];
  }

  markRemainingNotRun(fromPhase: PhaseNumber, reason: string): void {
    for (let phase = fromPhase; phase <= 5; phase += 1) {
      this.markNotRun(phase as PhaseNumber, reason);
    }
  }

  addArtifacts(phase: PhaseNumber, artifacts: string[]): void {
    const entry = this.require(phase);
    for (const artifact of artifacts) {
      if (!entry.outputArtifacts.includes(artifact)) entry.outputArtifacts.push(artifact);
    }
  }

  summaries(): PhaseExecutionSummary[] {
    return [1, 2, 3, 4, 5, 6].map((phase) => {
      const entry = this.require(phase as PhaseNumber);
      return {
        phase: entry.phase,
        name: entry.name,
        status: entry.status,
        ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
        ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
        outputArtifacts: [...entry.outputArtifacts],
        errors: [...entry.errors],
      };
    });
  }

  private require(phase: PhaseNumber): PhaseState {
    const entry = this.phases.get(phase);
    if (!entry) throw new Error(`Unknown phase ${phase}.`);
    return entry;
  }
}
