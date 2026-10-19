import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let directory = "";
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

it("writes identical redacted Gemini diagnostics to latest and matching run action logs", async () => {
  directory = await mkdtemp(join(tmpdir(), "ui-qa-logger-"));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.resetModules();
  const { resetActionLog, appendActionLog, evidenceDirectory } = await import("../src/evidence/logger.js");
  await resetActionLog();
  const event = {
    event: "gemini_request", runId: "TEST-RUN", scenarioId: "SC-01", requestKind: "executor",
    durationMs: 28_000, status: "error", apiStatusCode: 504,
    promptCharacterCount: 7_131, schemaByteCount: 4_824, apiKey: "test-secret",
  };
  await appendActionLog(event);

  const latest = await readFile(join(evidenceDirectory, "action-log.ndjson"), "utf8");
  const scoped = await readFile(join(evidenceDirectory, "runs", "TEST-RUN", "action-log.ndjson"), "utf8");
  expect(scoped).toBe(latest);
  expect(JSON.parse(scoped)).toMatchObject({ ...event, apiKey: "[REDACTED]" });
  expect(scoped).not.toContain("test-secret");
});
