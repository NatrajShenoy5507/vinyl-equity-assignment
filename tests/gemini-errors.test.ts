import { describe, expect, it } from "vitest";
import { getGeminiApiStatusCode, isGeminiServiceError } from "../src/agents/gemini-errors.js";

describe("Gemini service errors", () => {
  it.each([503, 504, 429])("recognizes HTTP %i failures from the SDK error", (status) => {
    const error = Object.assign(new Error(`Gemini request failed: ${status}`), { status });
    expect(getGeminiApiStatusCode(error)).toBe(status);
    expect(isGeminiServiceError(error)).toBe(true);
  });

  it("recognizes structured API error payloads and request timeouts", () => {
    const apiError = new Error(JSON.stringify({ error: { code: 504, status: "DEADLINE_EXCEEDED" } }));
    const timeout = Object.assign(new Error("Request timed out"), { name: "RequestTimeoutError" });
    expect(getGeminiApiStatusCode(apiError)).toBe(504);
    expect(isGeminiServiceError(apiError)).toBe(true);
    expect(getGeminiApiStatusCode(timeout)).toBeNull();
    expect(isGeminiServiceError(timeout)).toBe(true);
  });

  it("does not classify ordinary model/client errors as service outages", () => {
    expect(isGeminiServiceError(new Error("Gemini returned invalid JSON"))).toBe(false);
  });
});
