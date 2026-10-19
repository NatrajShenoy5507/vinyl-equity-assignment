import { readConfig } from "../config.js";
import { runGeminiSmoke } from "./gemini-smoke.js";

async function main(): Promise<void> {
  const config = readConfig();
  const result = await runGeminiSmoke({
    apiKey: config.GEMINI_API_KEY,
    model: config.GEMINI_MODEL,
    timeoutMs: config.GEMINI_EXECUTOR_TIMEOUT_MS,
  });
  process.stdout.write(`Gemini smoke ${result.status}: ${result.scope}\n`);
  process.stdout.write(`Diagnostics: evidence/runs/${result.runId}/action-log.ndjson\n`);
  process.stdout.write(`Summary: evidence/runs/${result.runId}/gemini-smoke.json\n`);
  if (result.error) {
    process.stderr.write(`Gemini smoke blocked (${result.error.name}${result.error.apiStatusCode === null ? "" : `; HTTP ${result.error.apiStatusCode}`}).\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // Avoid printing an SDK error object, which can contain request details.
  process.stderr.write(`Gemini smoke could not complete (${error instanceof Error ? error.name : "UnknownError"}).\n`);
  process.exitCode = 1;
});
