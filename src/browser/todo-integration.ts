import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { readConfig } from "../config.js";
import { evidenceDirectory } from "../evidence/logger.js";
import { validateToolAction } from "./tool-policy.js";
import { PlaywrightMcp } from "./playwright-mcp.js";

async function startTodoFixture(): Promise<{ server: Server; url: string }> {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Local Todo MCP fixture</title></head>
<body>
  <h1>todos</h1>
  <form id="todo-form">
    <label>What needs to be done? <input id="todo-input" autofocus></label>
    <button type="submit">Add</button>
  </form>
  <ul id="todo-list"></ul>
  <script>
    const form = document.querySelector("#todo-form");
    const input = document.querySelector("#todo-input");
    const list = document.querySelector("#todo-list");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      const item = document.createElement("li");
      item.textContent = value;
      list.append(item);
      input.value = "";
    });
  </script>
</body>
</html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the local Todo fixture address.");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  const runId = `mcp-todo-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outputDirectory = resolve(evidenceDirectory, "mcp-integration");
  await mkdir(outputDirectory, { recursive: true });
  const fixture = await startTodoFixture();
  const browser = new PlaywrightMcp(config.HEADLESS, config.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS);
  let result: { status: "PASS" | "BLOCKED"; scope: string; runId: string; targetUrl: string; createdTodo?: string; verifiedSnapshot?: string; reason?: string } = {
    status: "BLOCKED",
    scope: "Deterministic Gemini-free Playwright MCP integration against a local Todo fixture; not a target-app or autonomous AI test.",
    runId,
    targetUrl: fixture.url,
  };

  try {
    const tools = await browser.connect();
    const typeTool = tools.find((tool) => tool.name === "browser_type");
    if (!typeTool) throw new Error("Playwright MCP did not advertise browser_type.");
    const snapshotTool = tools.find((tool) => tool.name === "browser_snapshot");
    if (!snapshotTool) throw new Error("Playwright MCP did not advertise browser_snapshot.");

    const navigateArgs = validateToolAction("browser_navigate", { url: fixture.url }, tools, fixture.url);
    const navigation = await browser.call("browser_navigate", navigateArgs, config.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS);
    if (navigation.isError) throw new Error(`Navigation failed: ${navigation.text}`);

    const initial = await browser.call("browser_snapshot");
    if (initial.isError || !initial.text.trim()) throw new Error(`Initial snapshot failed: ${initial.text}`);
    const textboxReference = initial.text.match(/textbox[^\r\n]*\[ref=(e\d+)\]/)?.[1];
    if (!textboxReference) throw new Error("Initial accessibility snapshot did not expose a textbox reference.");

    const todoText = `MCP-QA-${runId}`;
    const typeProperties = typeTool.inputSchema.properties ?? {};
    const typeArguments: Record<string, unknown> = { target: textboxReference, text: todoText };
    if (typeProperties.submit) {
      typeArguments.submit = true;
    } else if (!tools.some((tool) => tool.name === "browser_press_key")) {
      throw new Error("Playwright MCP cannot submit the new Todo using browser_type or browser_press_key.");
    }
    const validTypeArguments = validateToolAction("browser_type", typeArguments, tools, fixture.url);
    const typed = await browser.call("browser_type", validTypeArguments);
    if (typed.isError) throw new Error(`Could not create Todo: ${typed.text}`);

    if (!typeProperties.submit) {
      const enterArgs = validateToolAction("browser_press_key", { key: "Enter" }, tools, fixture.url);
      const submitted = await browser.call("browser_press_key", enterArgs);
      if (submitted.isError) throw new Error(`Could not submit Todo: ${submitted.text}`);
    }

    const verified = await browser.call("browser_snapshot");
    if (verified.isError || !verified.text.includes(todoText)) {
      throw new Error(`Created Todo was not present in the follow-up accessibility snapshot: ${verified.text.slice(0, 1000)}`);
    }
    result = {
      ...result,
      status: "PASS",
      createdTodo: todoText,
      verifiedSnapshot: verified.text.slice(0, 3000),
    };
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await browser.close();
    } catch (error) {
      const closeReason = `Playwright MCP shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
      result.status = "BLOCKED";
      result.reason = result.reason ? `${result.reason}; ${closeReason}` : closeReason;
    }
    try {
      await closeServer(fixture.server);
    } catch (error) {
      const closeReason = `Local Todo fixture shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
      result.status = "BLOCKED";
      result.reason = result.reason ? `${result.reason}; ${closeReason}` : closeReason;
    }
  }

  const reportPath = resolve(outputDirectory, `${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  process.stdout.write(`Playwright MCP integration ${result.status}: ${result.scope}\nReport: ${reportPath}\n`);
  if (result.reason) {
    process.stderr.write(`${result.reason}\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Playwright MCP integration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
