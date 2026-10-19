import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateContentMock, appendActionLogMock, mkdirMock, writeFileMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  appendActionLogMock: vi.fn(async (_event: Record<string, unknown>) => undefined),
  mkdirMock: vi.fn(async () => undefined),
  writeFileMock: vi.fn(async (_path: string, _data: string, _encoding: string) => undefined),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly models = { generateContent: generateContentMock };
  },
}));
vi.mock("node:fs/promises", () => ({ mkdir: mkdirMock, writeFile: writeFileMock }));
vi.mock("../src/evidence/logger.js", () => ({
  appendActionLog: appendActionLogMock,
  evidenceDirectory: "test-evidence",
}));

import { geminiSmokeJsonSchema, geminiSmokePrompt, runGeminiSmoke } from "../src/agents/gemini-smoke.js";

describe("browser-free Gemini API smoke", () => {
  beforeEach(() => vi.clearAllMocks());

  it("makes exactly one tiny structured request and records its run-scoped diagnostics", async () => {
    generateContentMock.mockResolvedValueOnce({ text: '{"status":"ok"}' });

    const result = await runGeminiSmoke({
      apiKey: "smoke-secret", model: "gemini-test", timeoutMs: 8_000, runId: "smoke-unit-test",
    });

    expect(result.status).toBe("PASS");
    expect(generateContentMock).toHaveBeenCalledOnce();
    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-test",
      contents: geminiSmokePrompt,
      config: {
        responseMimeType: "application/json", responseJsonSchema: geminiSmokeJsonSchema,
        temperature: 0.1, httpOptions: { timeout: 8_000 },
      },
    });
    expect(geminiSmokePrompt.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(geminiSmokeJsonSchema))).toBeLessThan(200);
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "gemini_request", runId: "smoke-unit-test", requestKind: "smoke", status: "ok",
    }));
    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(writeFileMock.mock.calls.some(([path]) => /runs[/\\]smoke-unit-test[/\\]gemini-smoke\.json$/.test(path))).toBe(true);
    expect(JSON.stringify([...appendActionLogMock.mock.calls, ...writeFileMock.mock.calls])).not.toContain("smoke-secret");
  });

  it.each(['{"status":"wrong"}', '{"status":"ok","extra":"untrusted"}']) (
    "blocks on unexpected response %s even if the API request succeeded",
    async (text) => {
      generateContentMock.mockResolvedValueOnce({ text });

      const result = await runGeminiSmoke({ apiKey: "secret", model: "gemini-test", runId: "smoke-invalid" });

      expect(result.status).toBe("BLOCKED");
      expect(result.error?.name).toBe("ZodError");
      expect(generateContentMock).toHaveBeenCalledOnce();
      expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
        event: "gemini_smoke_result", runId: "smoke-invalid", status: "BLOCKED",
      }));
    },
  );

  it("reports HTTP 504 without retrying or retaining sensitive SDK error messages", async () => {
    generateContentMock.mockRejectedValueOnce(Object.assign(new Error("HTTP 504 with sensitive-secret and prompt data"), { status: 504 }));

    const result = await runGeminiSmoke({ apiKey: "sensitive-secret", model: "gemini-test", runId: "smoke-api-error" });

    expect(result.status).toBe("BLOCKED");
    expect(result.error).toEqual({ name: "Error", apiStatusCode: 504 });
    expect(generateContentMock).toHaveBeenCalledOnce();
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "gemini_request", runId: "smoke-api-error", status: "error", apiStatusCode: 504,
    }));
    expect(JSON.stringify([...appendActionLogMock.mock.calls, ...writeFileMock.mock.calls])).not.toContain("sensitive-secret");
  });

  it("blocks with no request when the key is missing", async () => {
    const result = await runGeminiSmoke({ apiKey: undefined, model: "gemini-test", runId: "smoke-no-key" });

    expect(result.status).toBe("BLOCKED");
    expect(generateContentMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledTimes(2);
  });
});
