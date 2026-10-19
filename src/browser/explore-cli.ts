import { readConfig } from "../config.js";
import { createExplorationRunId, exploreApplication } from "./explorer.js";

async function main(): Promise<void> {
  const config = readConfig();
  const context = await exploreApplication({
    targetUrl: config.TARGET_URL,
    runId: createExplorationRunId(),
    headless: config.HEADLESS,
    navigationTimeoutMs: config.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS,
  });
  process.stdout.write(`Application exploration ${context.status}: ${context.targetUrl}\n`);
  process.stdout.write("Context: evidence/application-context.json\n");
  if (context.evidence.screenshot) process.stdout.write(`Screenshot: evidence/${context.evidence.screenshot}\n`);
  if (context.diagnostics.length > 0) {
    for (const diagnostic of context.diagnostics) {
      process.stderr.write(`${diagnostic.stage}: ${diagnostic.message}\n`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Application exploration failed before reporting: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
