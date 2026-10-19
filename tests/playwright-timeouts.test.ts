import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { callTool, transportOptions } = vi.hoisted(() => ({ callTool: vi.fn(), transportOptions: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { constructor(options: unknown) { transportOptions(options); } } }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class { callTool = callTool; } }));
import { PlaywrightMcp } from "../src/browser/playwright-mcp.js";
import { BrowserToolError } from "../src/browser/browser-errors.js";
import { isGeminiServiceError } from "../src/agents/gemini-errors.js";

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  callTool.mockResolvedValue({ content: [{ type: "text", text: "Observed page" }] });
});
afterEach(() => vi.useRealTimers());

describe("Playwright navigation request budgets", () => {
  it("defaults navigation to 60 seconds at both SDK and server layers", async () => {
    await new PlaywrightMcp(true).call("browser_navigate", { url: "https://demo.test/" });
    expect(transportOptions).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(["--isolated", "--timeout-navigation", "60000"]) }));
    expect(callTool).toHaveBeenCalledWith({ name: "browser_navigate", arguments: { url: "https://demo.test/" } }, undefined,
      expect.objectContaining({ timeout: 60_000, maxTotalTimeout: 60_000, resetTimeoutOnProgress: false }));
  });
  it("supports longer configured navigation without an earlier SDK default timeout", async () => {
    await new PlaywrightMcp(false, 90_000).call("browser_navigate", { url: "https://demo.test/" });
    expect(callTool.mock.calls[0]![2]).toMatchObject({ timeout: 90_000, maxTotalTimeout: 90_000, resetTimeoutOnProgress: false });
    expect(transportOptions.mock.calls[0]![0].args).toContain("90000");
  });
  it.each(["browser_snapshot", "browser_click", "browser_hover", "browser_type", "browser_press_key"])("keeps %s at its existing 20-second wrapper limit", async (tool) => {
    await new PlaywrightMcp(true, 90_000).call(tool, {});
    expect(callTool.mock.calls[0]![2]).toMatchObject({ timeout: 20_000, maxTotalTimeout: 20_000 });
  });
  it("caps SDK and outer navigation timers to the caller's remaining deadline and cancels the request", async () => {
    callTool.mockImplementation(() => new Promise(() => undefined));
    const pending = new PlaywrightMcp(true, 90_000).call("browser_navigate", { url: "https://demo.test/" }, 1_250);
    const outcome = pending.catch((error: unknown) => error);
    expect(callTool.mock.calls[0]![2]).toMatchObject({ timeout: 1_250, maxTotalTimeout: 1_250, resetTimeoutOnProgress: false });
    await vi.advanceTimersByTimeAsync(1_249);
    expect(callTool.mock.calls[0]![2].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(BrowserToolError);
    expect(error).toMatchObject({ source: "browser", timeoutMs: 1_250, operation: "Playwright MCP tool browser_navigate" });
    expect(isGeminiServiceError(error)).toBe(false);
    expect(callTool.mock.calls[0]![2].signal.aborted).toBe(true);
  });
  it("does not let an explicit call exceed the configured navigation cap", async () => {
    await new PlaywrightMcp(true, 30_000).call("browser_navigate", {}, 90_000);
    expect(callTool.mock.calls[0]![2]).toMatchObject({ timeout: 30_000, maxTotalTimeout: 30_000 });
  });
  it("tags an MCP SDK rejection as browser-origin even if it includes a service-like status", async () => {
    callTool.mockRejectedValue(Object.assign(new Error("HTTP 504: Request timed out"), { status: 504 }));
    const error = await new PlaywrightMcp(true).call("browser_navigate").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserToolError); expect(isGeminiServiceError(error)).toBe(false);
  });
});
