import { describe, expect, it } from "vitest";
import { summarizeGeminiFinishMetadata, summarizeJsonResponse } from "../src/agents/response-diagnostics.js";

describe("safe JSON response summaries", () => {
  it.each([
    { value: null, type: "null", discriminator: "missing" },
    { value: false, type: "boolean", discriminator: "missing" },
    { value: true, type: "boolean", discriminator: "missing" },
    { value: [], type: "array", discriminator: "missing" },
    { value: {}, type: "object", discriminator: "missing" },
    { value: { kind: "finish" }, type: "object", discriminator: "finish" },
    { value: { kind: "action" }, type: "object", discriminator: "action" },
    { value: { kind: "private text" }, type: "object", discriminator: "unknown_string" },
    { value: { kind: null }, type: "object", discriminator: "null" },
    { value: { kind: false }, type: "object", discriminator: "boolean" },
    { value: { kind: 5 }, type: "object", discriminator: "number" },
    { value: { kind: {} }, type: "object", discriminator: "object" },
    { value: { kind: [] }, type: "object", discriminator: "array" },
  ])("classifies $type response with $discriminator discriminator", ({ value, type, discriminator }) => {
    expect(summarizeJsonResponse(value)).toMatchObject({
      responseType: type,
      responseDiscriminator: discriminator,
      responseByteCount: Buffer.byteLength(JSON.stringify(value)),
    });
  });

  it("uses the original wire response size when supplied", () => {
    expect(summarizeJsonResponse({ kind: "finish" }, 123)).toMatchObject({ responseByteCount: 123 });
  });

  it("never logs unknown top-level keys or nested data", () => {
    const summary = summarizeJsonResponse({
      "private-key-and-page-text": "private-value",
      kind: "private-discriminator",
      arguments: { text: "private-nested-data" },
      assessments: [{ observedEvidence: "private-observation" }],
    });
    expect(summary).toMatchObject({
      responseTopLevelKeys: ["kind", "arguments", "assessments"],
      responseUnknownTopLevelKeyCount: 1,
      responseDiscriminator: "unknown_string",
    });
    expect(JSON.stringify(summary)).not.toContain("private");
  });
});

describe("safe Gemini finish metadata", () => {
  it("copies finite SDK enums and numeric token counts only", () => {
    expect(summarizeGeminiFinishMetadata({
      candidates: [{ finishReason: "MAX_TOKENS", finishMessage: "private finish message" }],
      promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "private block message" },
      usageMetadata: {
        promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120,
        thoughtsTokenCount: -1, toolUsePromptTokenCount: "private metadata", cachedContentTokenCount: Infinity,
      },
    })).toEqual({
      candidateCount: 1,
      finishReasons: ["MAX_TOKENS"],
      blockedReason: "SAFETY",
      usageTokenCounts: { candidatesTokenCount: 20, promptTokenCount: 100, totalTokenCount: 120 },
    });
  });

  it("bounds finish metadata and omits arbitrary unknown fields", () => {
    const metadata = summarizeGeminiFinishMetadata({
      candidates: Array.from({ length: 10 }, () => ({ finishReason: "private-content", content: "private-content" })),
      promptFeedback: { blockReason: "private-content" },
      usageMetadata: { "private-content": 123 },
    });
    expect(metadata).toEqual({
      candidateCount: 10, finishReasons: Array(8).fill("UNKNOWN"), blockedReason: "UNKNOWN", usageTokenCounts: {},
    });
    expect(JSON.stringify(metadata)).not.toContain("private-content");
  });

  it.each([null, true, {}, { candidates: [null, false, {}], promptFeedback: null, usageMetadata: false }])(
    "handles missing or malformed metadata without retaining the source",
    (response) => {
      expect(() => summarizeGeminiFinishMetadata(response)).not.toThrow();
      expect(summarizeGeminiFinishMetadata(response).usageTokenCounts).toEqual({});
    },
  );
});
