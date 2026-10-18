import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { readConfig } from "../config.js";
import { appendActionLog, evidenceDirectory } from "../evidence/logger.js";
import { getPermittedTools, validateToolAction } from "./tool-policy.js";
import { PlaywrightMcp } from "./playwright-mcp.js";
async function main() {
    const config = readConfig();
    const runId = `browser-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const screenshotDirectory = resolve(evidenceDirectory, "screenshots", runId);
    await mkdir(screenshotDirectory, { recursive: true });
    let browser;
    let snapshotCharacters = 0;
    let screenshotPath;
    let blocker;
    let consoleErrorsReported = null;
    let toolNames = [];
    let permittedTools = [];
    let navigationExecuted = false;
    try {
        browser = new PlaywrightMcp(config.HEADLESS);
        const discovered = await browser.connect();
        toolNames = discovered.map((tool) => tool.name);
        permittedTools = getPermittedTools(discovered).map(({ name, inputSchema }) => ({ name, inputSchema }));
        for (const required of ["browser_navigate", "browser_snapshot", "browser_take_screenshot"]) {
            if (!toolNames.includes(required))
                throw new Error(`Playwright MCP did not advertise required tool ${required}.`);
        }
        const navigationArguments = validateToolAction("browser_navigate", { url: config.TARGET_URL }, discovered, config.TARGET_URL);
        validateToolAction("browser_snapshot", {}, discovered, config.TARGET_URL);
        const navigation = await browser.call("browser_navigate", navigationArguments);
        if (navigation.isError)
            throw new Error(`Navigation failed: ${navigation.text}`);
        const consoleSummary = navigation.text.match(/Console:\s*(\d+)\s+errors?/i);
        if (consoleSummary)
            consoleErrorsReported = Number(consoleSummary[1]);
        navigationExecuted = true;
        await appendActionLog({ timestamp: new Date().toISOString(), runId, toolName: "browser_navigate", arguments: { url: config.TARGET_URL }, status: "ok", result: navigation.text.slice(0, 1500) });
        const snapshot = await browser.call("browser_snapshot");
        if (snapshot.isError || snapshot.text.trim().length === 0)
            throw new Error(`Browser snapshot is empty or failed: ${snapshot.text}`);
        snapshotCharacters = snapshot.text.length;
        await appendActionLog({ timestamp: new Date().toISOString(), runId, toolName: "browser_snapshot", status: "ok", result: snapshot.text.slice(0, 1500) });
        screenshotPath = resolve(screenshotDirectory, "todomvc.png");
        await browser.screenshot(screenshotPath);
        await appendActionLog({ timestamp: new Date().toISOString(), runId, toolName: "browser_take_screenshot", status: "ok", result: relative(evidenceDirectory, screenshotPath).replaceAll("\\", "/") });
    }
    catch (error) {
        blocker = error instanceof Error ? error.message : String(error);
        await appendActionLog({ timestamp: new Date().toISOString(), runId, event: "browser_smoke_blocked", message: blocker });
    }
    finally {
        if (browser) {
            try {
                await browser.close();
            }
            catch (error) {
                const message = `Playwright MCP shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
                blocker = blocker ? `${blocker}; ${message}` : message;
                await appendActionLog({ timestamp: new Date().toISOString(), runId, event: "browser_smoke_close_error", message });
            }
        }
    }
    const report = {
        runId,
        status: blocker ? "BLOCKED" : "PASS",
        scope: "MCP infrastructure smoke only; no Gemini planning or acceptance criteria were evaluated.",
        targetUrl: config.TARGET_URL,
        startedAt,
        completedAt: new Date().toISOString(),
        toolsDiscovered: toolNames,
        permittedToolSchemas: permittedTools,
        consoleErrorsReported,
        navigationExecuted,
        snapshotCharacters,
        screenshot: screenshotPath && existsSync(screenshotPath) ? relative(evidenceDirectory, screenshotPath).replaceAll("\\", "/") : null,
        ...(blocker ? { blocker } : {}),
    };
    await writeFile(resolve(evidenceDirectory, "browser-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`Browser smoke ${report.status}: ${report.scope}\n`);
    if (blocker) {
        process.stderr.write(`${blocker}\n`);
        process.exitCode = 1;
    }
    else {
        process.stdout.write(`Snapshot: ${snapshotCharacters} characters; screenshot: evidence/${report.screenshot}\n`);
    }
}
main().catch((error) => {
    process.stderr.write(`Browser smoke failed before reporting: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
