import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export const evidenceDirectory = resolve(process.cwd(), "evidence");

export async function resetActionLog(): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
}

export async function appendActionLog(event: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(event)
    .replace(/(api[_-]?key|authorization|token|cookie)(["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1$2[REDACTED]");
  const line = `${serialized}\n`;
  await appendFile(resolve(evidenceDirectory, "action-log.ndjson"), line, "utf8");
  if (typeof event.runId === "string" && event.runId.trim()) {
    const runLog = resolve(evidenceDirectory, "runs", event.runId, "action-log.ndjson");
    await mkdir(resolve(runLog, ".."), { recursive: true });
    await appendFile(runLog, line, "utf8");
  }
}
