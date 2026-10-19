import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { InvalidGeminiJsonError } from "../src/agents/response-diagnostics.js";
import { GeminiRequestError, isGeminiServiceError } from "../src/agents/gemini-errors.js";

describe("Gemini request behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a successful JSON response and records redacted request diagnostics", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: '{"kind":"finish"}',
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
    });
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(175);
    const agent = new GeminiAgent("test-secret-not-for-logs", "gemini-unit-test", { runId: "run-unit-test" });
    const result = await agent.generateJson("executor prompt", { type: "object" }, 5_000, "executor", { scenarioId: "SC-01" });

    expect(result).toEqual({ kind: "finish" });
    expect(constructorMock).toHaveBeenCalledWith(expect.objectContaining({
      httpOptions: { retryOptions: { attempts: 1 } },
    }));
    expect(generateContentMock).toHaveBeenCalledOnce();
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "gemini_request",
      runId: "run-unit-test",
      scenarioId: "SC-01",
      requestKind: "executor",
      model: "gemini-unit-test",
      timeoutMs: 5_000,
      durationMs: 75,
      promptCharacterCount: "executor prompt".length,
      promptByteCount: Buffer.byteLength("executor prompt"),
      schemaByteCount: Buffer.byteLength('{"type":"object"}'),
      requestByteCount: Buffer.byteLength(JSON.stringify(generateContentMock.mock.calls[0]![0])),
      responseByteCount: Buffer.byteLength('{"kind":"finish"}'),
      retryCount: 0,
      retryPolicy: "disabled",
      status: "ok",
      apiStatusCode: null,
      responseType: "object",
      responseTopLevelKeys: ["kind"],
      responseUnknownTopLevelKeyCount: 0,
      responseDiscriminator: "finish",
      candidateCount: 1,
      finishReasons: ["STOP"],
      blockedReason: null,
      usageTokenCounts: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
    }));
    expect(JSON.stringify(appendActionLogMock.mock.calls)).not.toContain("test-secret-not-for-logs");
    expect(JSON.stringify(appendActionLogMock.mock.calls)).not.toContain("executor prompt");
    expect(JSON.stringify(appendActionLogMock.mock.calls)).not.toContain('{"kind":"finish"}');
    expect(generateContentMock.mock.calls[0]![0].config.httpOptions).toEqual({ timeout: 5_000 });
  });

  it.each([503, 504, 429])("records HTTP %i and surfaces the model request error without retries", async (status) => {
    const error = Object.assign(new Error(`HTTP ${status}: simulated Gemini failure`), { status });
    generateContentMock.mockRejectedValueOnce(error);
    const agent = new GeminiAgent("test-secret", "gemini-unit-test");

    await expect(agent.generateJson("prompt", { type: "object" }, 5_000, "executor")).rejects.toMatchObject({ name: "GeminiRequestError", source: "gemini", httpStatus: status, cause: error });
    expect(generateContentMock).toHaveBeenCalledOnce();
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      apiStatusCode: status,
      retryCount: 0,
      errorName: "Error",
      responseByteCount: null,
    }));
  });

  it("records a request timeout as an error with no HTTP status", async () => {
    const error = Object.assign(new Error("The request timed out"), { name: "RequestTimeoutError" });
    generateContentMock.mockRejectedValueOnce(error);
    const agent = new GeminiAgent("test-secret", "gemini-unit-test");

    const failure = await agent.generateJson("prompt", { type: "object" }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(GeminiRequestError);
    expect(failure).toMatchObject({ source: "gemini", cause: error });
    expect(isGeminiServiceError(failure)).toBe(true);
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      apiStatusCode: null,
      retryCount: 0,
      errorName: "RequestTimeoutError",
    }));
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it("routes a revalidation request to its own run-scoped log", async () => {
    generateContentMock.mockResolvedValueOnce({ text: '{"kind":"finish"}' });
    const agent = new GeminiAgent("test-secret", "gemini-unit-test", { runId: "original-run" });
    await agent.generateJson("prompt", { type: "object" }, 1_000, "executor", {
      runId: "revalidation-run", scenarioId: "SC-02",
    });

    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: "revalidation-run", scenarioId: "SC-02", requestKind: "executor",
    }));
  });

  it("logs invalid JSON response size without retaining the response body", async () => {
    const response = "invalid JSON with sensitive response content";
    generateContentMock.mockResolvedValueOnce({ text: response });
    const agent = new GeminiAgent("test-secret", "gemini-unit-test");

    const error = await agent.generateJson("prompt", { type: "object" }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(InvalidGeminiJsonError);
    expect(error).toMatchObject({ message: "Gemini returned invalid JSON; the response body was omitted from diagnostics." });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("sensitive response content");
    expect(appendActionLogMock).toHaveBeenCalledOnce();
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "error", responseByteCount: Buffer.byteLength(response), apiStatusCode: null,
      responseType: "invalid_json", responseTopLevelKeys: [], responseDiscriminator: "unavailable",
    }));
    expect(JSON.stringify(appendActionLogMock.mock.calls)).not.toContain(response);
  });

  it.each([
    { text: "null", responseType: "null", discriminator: "missing", keys: [] },
    { text: "true", responseType: "boolean", discriminator: "missing", keys: [] },
    { text: "false", responseType: "boolean", discriminator: "missing", keys: [] },
    { text: "{}", responseType: "object", discriminator: "missing", keys: [] },
    { text: '{"kind":"unrecognized-private-output"}', responseType: "object", discriminator: "unknown_string", keys: ["kind"] },
    { text: '{"kind":"action"}', responseType: "object", discriminator: "action", keys: ["kind"] },
  ])("records only safe structural diagnostics for $text", async ({ text, responseType, discriminator, keys }) => {
    generateContentMock.mockResolvedValueOnce({ text });
    const agent = new GeminiAgent("test-secret", "gemini-unit-test");

    await expect(agent.generateJson("prompt", { type: "object" })).resolves.toEqual(JSON.parse(text));
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "ok",
      responseType,
      responseTopLevelKeys: keys,
      responseDiscriminator: discriminator,
      responseByteCount: Buffer.byteLength(text),
    }));
    expect(JSON.stringify(appendActionLogMock.mock.calls)).not.toContain("unrecognized-private-output");
  });

  it("redacts unknown response keys, discriminator values, and untrusted SDK metadata", async () => {
    const secret = "private-page-content-and-api-key";
    const text = JSON.stringify({ kind: secret, [secret]: "private value", rationale: secret });
    generateContentMock.mockResolvedValueOnce({
      text,
      candidates: [{ finishReason: secret, finishMessage: secret, content: { parts: [{ text: secret }] } }],
      promptFeedback: { blockReason: secret, blockReasonMessage: secret, safetyRatings: [{ category: secret }] },
      usageMetadata: { promptTokenCount: 23, totalTokenCount: secret, [secret]: secret },
      modelVersion: secret,
      responseId: secret,
    });
    const agent = new GeminiAgent(secret, "gemini-unit-test");
    await agent.generateJson("prompt", { type: "object" });

    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      responseType: "object",
      responseTopLevelKeys: ["kind", "rationale"],
      responseUnknownTopLevelKeyCount: 1,
      responseDiscriminator: "unknown_string",
      candidateCount: 1,
      finishReasons: ["UNKNOWN"],
      blockedReason: "UNKNOWN",
      usageTokenCounts: { promptTokenCount: 23 },
    }));
    expect(JSON.stringify(appendActionLogMock.mock.calls)).not.toContain(secret);
  });

  it.each([undefined, ""])("retains safe blocked-response metadata when response text is %s", async (text) => {
    generateContentMock.mockResolvedValueOnce({
      text,
      candidates: [],
      promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "private page content" },
    });
    const agent = new GeminiAgent("test-secret", "gemini-unit-test");

    await expect(agent.generateJson("prompt", { type: "object" })).rejects.toBeInstanceOf(InvalidGeminiJsonError);
    expect(appendActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "error", errorName: "InvalidGeminiJsonError", responseByteCount: 0,
      responseType: "empty", responseTopLevelKeys: [], responseDiscriminator: "unavailable",
      candidateCount: 0, finishReasons: [], blockedReason: "SAFETY",
    }));
    expect(JSON.stringify(appendActionLogMock.mock.calls)).not.toContain("private page content");
  });

  it.each([0, -1, Infinity, NaN])("rejects invalid timeout %s before calling the API", async (timeoutMs) => {
    const agent = new GeminiAgent("test-secret", "gemini-unit-test");
    await expect(agent.generateJson("prompt", { type: "object" }, timeoutMs)).rejects.toThrow("positive finite");
    expect(generateContentMock).not.toHaveBeenCalled();
  });
});
