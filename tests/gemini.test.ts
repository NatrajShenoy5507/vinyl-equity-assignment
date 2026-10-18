import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateContentMock, constructorMock, appendActionLogMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  constructorMock: vi.fn(),
  appendActionLogMock: vi.fn(async (_event: Record<string, unknown>) => undefined),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly models = { generateContent: generateContentMock };
    constructor(options: unknown) {
      constructorMock(options);
    }
  },
}));
vi.mock("../src/evidence/logger.js", () => ({ appendActionLog: appendActionLogMock }));

import { GeminiAgent } from "../src/agents/gemini.js";

describe("Gemini request behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a successful JSON response and records redacted request diagnostics", async () => {
    generateContentMock.mockResolvedValueOnce({ text: '{"kind":"finish"}' });
    const agent = new GeminiAgent("test-secret-not-for-logs", "gemini-unit-test");
    const result = await agent.generateJson("executor prompt", { type: "object" }, 5_000, "executor");

    expect(result).toEqual({ kind: "finish" });
    expect(constructorMock).toHaveBeenCalledWith(expect.objectContaining({
      httpOptions: { retryOptions: { attempts: 1 } },
    }));
    expect(generateContentMock).toHaveBeenCalledOnce();
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "gemini_request",
      requestKind: "executor",
      model: "gemini-unit-test",
      promptCharacterCount: "executor prompt".length,
      schemaByteCount: Buffer.byteLength('{"type":"object"}'),
      retryCount: 0,
      retryPolicy: "disabled",
      status: "ok",
      apiStatusCode: null,
    }));
    expect(JSON.stringify(appendActionLogMock.mock.calls)).not.toContain("test-secret-not-for-logs");
  });

  it.each([503, 504, 429])("records HTTP %i and surfaces the model request error without retries", async (status) => {
    const error = Object.assign(new Error(`HTTP ${status}: simulated Gemini failure`), { status });
    generateContentMock.mockRejectedValueOnce(error);
    const agent = new GeminiAgent("test-secret", "gemini-unit-test");

    await expect(agent.generateJson("prompt", { type: "object" }, 5_000, "executor")).rejects.toBe(error);
    expect(generateContentMock).toHaveBeenCalledOnce();
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      apiStatusCode: status,
      retryCount: 0,
      errorName: "Error",
    }));
  });

  it("records a request timeout as an error with no HTTP status", async () => {
    const error = Object.assign(new Error("The request timed out"), { name: "RequestTimeoutError" });
    generateContentMock.mockRejectedValueOnce(error);
    const agent = new GeminiAgent("test-secret", "gemini-unit-test");

    await expect(agent.generateJson("prompt", { type: "object" })).rejects.toBe(error);
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      apiStatusCode: null,
      retryCount: 0,
      errorName: "RequestTimeoutError",
    }));
    expect(generateContentMock).toHaveBeenCalledOnce();
  });
});
