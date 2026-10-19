import { beforeEach, describe, expect, it, vi } from "vitest";

const { transportConstructorMock, connectMock, closeMock } = vi.hoisted(() => ({
  transportConstructorMock: vi.fn(),
  connectMock: vi.fn(async (_transport: unknown) => undefined),
  closeMock: vi.fn(async () => undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(options: unknown) {
      transportConstructorMock(options);
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    readonly connect = connectMock;
    readonly close = closeMock;
    async listTools() {
      return { tools: [{ name: "browser_snapshot", inputSchema: { type: "object", properties: {} } }] };
    }
  },
}));

import { PlaywrightMcp } from "../src/browser/playwright-mcp.js";

describe("Playwright MCP scenario isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([true, false])("always requests an ephemeral browser profile (headless=%s)", (headless) => {
    new PlaywrightMcp(headless);

    expect(transportConstructorMock).toHaveBeenCalledExactlyOnceWith({
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["-y", "@playwright/mcp@latest", "--isolated", "--timeout-navigation", "60000", ...(headless ? ["--headless"] : [])],
      cwd: process.cwd(),
      stderr: "inherit",
    });
    // All SDK classes are mocked: this test never launches MCP or a browser.
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("gives successive scenario clients separate isolated transports", async () => {
    const firstScenario = new PlaywrightMcp(true);
    const secondScenario = new PlaywrightMcp(true);
    await firstScenario.connect();
    await firstScenario.close();
    await secondScenario.connect();
    await secondScenario.close();

    expect(transportConstructorMock).toHaveBeenCalledTimes(2);
    expect(transportConstructorMock.mock.calls.every(([options]) => options.args.includes("--isolated"))).toBe(true);
    expect(connectMock.mock.calls[0]![0]).not.toBe(connectMock.mock.calls[1]![0]);
    expect(closeMock).toHaveBeenCalledTimes(2);
  });
});
