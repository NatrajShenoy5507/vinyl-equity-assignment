import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { validateToolArguments } from "./tool-policy.js";
const callResultSchema = z.object({
    content: z.array(z.unknown()).optional(),
    isError: z.boolean().optional(),
}).passthrough();
const textContentSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const imageContentSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).passthrough();
async function withTimeout(promise, timeoutMs, operation) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms.`)), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export class PlaywrightMcp {
    headless;
    client;
    transport;
    tools = [];
    constructor(headless) {
        this.headless = headless;
        this.client = new Client({ name: "autonomous-ui-qa-agent", version: "1.0.0" }, { capabilities: {} });
        const isWindows = process.platform === "win32";
        this.transport = new StdioClientTransport({
            command: isWindows ? "npx.cmd" : "npx",
            args: ["-y", "@playwright/mcp@latest", ...(headless ? ["--headless"] : [])],
            cwd: process.cwd(),
            stderr: "inherit",
        });
    }
    async connect() {
        await withTimeout(this.client.connect(this.transport), 30_000, "Playwright MCP connection");
        const response = await withTimeout(this.client.listTools(), 20_000, "Playwright MCP tool discovery");
        this.tools = response.tools;
        if (this.tools.length === 0)
            throw new Error("Playwright MCP connected but did not advertise any tools.");
        return this.tools;
    }
    get discoveredTools() {
        return this.tools;
    }
    async call(name, args = {}, timeoutMs = 20_000) {
        const response = await withTimeout(this.client.callTool({ name, arguments: args }), timeoutMs, `Playwright MCP tool ${name}`);
        const parsed = callResultSchema.safeParse(response);
        if (!parsed.success || !parsed.data.content) {
            if ("toolResult" in response)
                throw new Error(`Playwright MCP tool ${name} returned a task result instead of a completed tool response.`);
            throw new Error(`Playwright MCP tool ${name} returned an invalid response.`);
        }
        const text = parsed.data.content.map((item) => {
            const textItem = textContentSchema.safeParse(item);
            if (textItem.success)
                return textItem.data.text;
            const imageItem = imageContentSchema.safeParse(item);
            if (imageItem.success)
                return "[image content]";
            return "[non-text MCP content]";
        }).join("\n");
        return { text, isError: parsed.data.isError === true, raw: response };
    }
    async screenshot(filePath, timeoutMs = 20_000) {
        const screenshotTool = this.tools.find((tool) => tool.name === "browser_take_screenshot");
        if (!screenshotTool)
            throw new Error("Playwright MCP server does not provide browser_take_screenshot.");
        await mkdir(resolve(filePath, ".."), { recursive: true });
        const args = {};
        if (screenshotTool.inputSchema.properties?.filename)
            args.filename = filePath;
        if (screenshotTool.inputSchema.properties?.scale)
            args.scale = "css";
        for (const required of screenshotTool.inputSchema.required ?? []) {
            if (required === "filename")
                args.filename = filePath;
            else if (required === "scale")
                args.scale = "css";
            else if (required === "fullPage")
                args.fullPage = false;
            else if (!(required in args))
                throw new Error(`Unsupported required screenshot argument "${required}" in discovered MCP schema.`);
        }
        const validatedArgs = validateToolArguments(args, screenshotTool.inputSchema);
        const rawResult = await withTimeout(this.client.callTool({ name: screenshotTool.name, arguments: validatedArgs }), timeoutMs, "Playwright screenshot");
        const parsed = callResultSchema.safeParse(rawResult);
        if (!parsed.success || !parsed.data.content)
            throw new Error("Playwright screenshot returned an invalid MCP response.");
        if (parsed.data.isError) {
            const message = parsed.data.content.map((item) => textContentSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data.text).join(" ");
            throw new Error(`Screenshot tool failed: ${message}`);
        }
        const image = parsed.data.content.map((item) => imageContentSchema.safeParse(item)).find((item) => item.success);
        if (image?.success)
            await writeFile(filePath, Buffer.from(image.data.data, "base64"));
        if (!existsSync(filePath)) {
            const text = parsed.data.content.map((item) => textContentSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data.text).join(" ");
            throw new Error(`Playwright did not create the requested screenshot file${text ? `: ${text}` : "."}`);
        }
    }
    async close() {
        await withTimeout(this.client.close(), 10_000, "Playwright MCP shutdown");
    }
}
